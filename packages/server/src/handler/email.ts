import type {
    ExecutionContext,
    ForwardableEmailMessage,
    ReadableStream as WorkerReadableStream,
} from '@cloudflare/workers-types';
import type { AttachmentRecord, EmailRecord, Environment, ParsedEmailResult, RuntimeSettings } from '../types';
import { Dao } from '../db';
import { warnIfSchemaOutdated } from '../db/schema';
import { loadDiscoveredDomain, loadSettings } from '../db/settings';
import { hydrateEmail, isMessageBlock, parseEmail, renderEmailListMode } from '../mail';
import { createTelegramBotAPI } from '../telegram';

const BODY_INLINE_LIMIT = 900 * 1024;

/**
 * Smallest prefix buffered for the delivery identity. Without a floor a
 * degenerate `maxEmailSize` would hash an empty prefix and collapse every
 * message onto one identity.
 */
const MIN_IDENTITY_BYTES = 4096;

/**
 * Reads at most `limit` bytes, stopping early on the truncating path instead of
 * draining the rest of the message into memory.
 */
async function readBytes(stream: WorkerReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (total < limit) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            const remaining = limit - total;
            if (value.byteLength <= remaining) {
                chunks.push(value);
                total += value.byteLength;
            } else {
                chunks.push(value.subarray(0, remaining));
                total = limit;
            }
        }
    } finally {
        // The bytes past the limit are not wanted, so release the stream rather
        // than reading to the end.
        await reader.cancel().catch(() => undefined);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return bytes;
}

/**
 * How many bytes the delivery identity covers: exactly the prefix `parseEmail`
 * will look at. A truncating policy caps at `maxEmailSize`, `unhandled` returns
 * before reading the body, and only `continue` parses an oversized message in
 * full. Buffering more would pin memory for bytes that are about to be thrown
 * away.
 */
function identityBufferLimit(message: ForwardableEmailMessage, settings: RuntimeSettings): number {
    const { maxEmailSize, maxEmailSizePolicy } = settings;
    if (maxEmailSizePolicy === 'continue') {
        return Math.max(message.rawSize, MIN_IDENTITY_BYTES);
    }
    if (maxEmailSizePolicy === 'unhandled') {
        return MIN_IDENTITY_BYTES;
    }
    return Math.max(Math.min(message.rawSize, maxEmailSize), MIN_IDENTITY_BYTES);
}

function toHex(buffer: ArrayBuffer): string {
    return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(data: Uint8Array | string): Promise<string> {
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    return toHex(await crypto.subtle.digest('SHA-256', bytes.buffer as ArrayBuffer));
}

/**
 * Stable identity for one delivery, used as the journal key and as the stored
 * `message_id`.
 *
 * `Message-ID` is assigned by the sending client and preserved by Email Routing
 * across retries, which is exactly the property deduplication needs: the same
 * delivery resolves to the same identity even if the transport perturbs the
 * bytes. It is mixed with the envelope sender and the raw size because a header
 * alone is only unique per sender — without the sender, two different senders
 * could land on one journal slot and a message would be dropped silently.
 *
 * Mail without a `Message-ID` is not standards-conformant, so for that case the
 * identity falls back to a digest of a bounded prefix of the bytes. The bound is
 * what `parseEmail` will look at anyway, so a retry still resolves to the same
 * value without buffering the whole message.
 */
async function resolveMessageIdentity(
    message: ForwardableEmailMessage,
    settings: RuntimeSettings,
): Promise<{ id: string; rawBytes: Uint8Array | null }> {
    const from = (message.from || '').trim().toLowerCase();
    const header = message.headers.get('Message-ID')?.trim();
    if (header) {
        return { id: `sha256:${await sha256Hex(`${header}\n${from}\n${message.rawSize}`)}`, rawBytes: null };
    }
    const rawBytes = await readBytes(message.raw, identityBufferLimit(message, settings));
    const prefix = await sha256Hex(rawBytes);
    return { id: `sha256:${await sha256Hex(`content\n${from}\n${message.rawSize}\n${prefix}`)}`, rawBytes };
}

async function persistEmail(
    env: Environment,
    dao: Dao,
    parsed: ParsedEmailResult,
    folder: 'inbox' | 'spam',
    rawSize: number,
    settings: RuntimeSettings,
): Promise<EmailRecord> {
    const id = crypto.randomUUID();
    const attachmentRecords: AttachmentRecord[] = [];

    // A truncated message was cut off mid-stream, and attachments sit after the
    // body in the MIME parts, so anything parsed out of it is a fragment. Storing
    // a partial file would hand the owner a corrupt download that looks normal,
    // so save nothing and say so instead. Raising `maxEmailSize` above the mail
    // size (including the MIME overhead) is what makes attachments arrive whole.
    if (parsed.truncated && parsed.attachments.length > 0) {
        console.error('[email] attachment.skip.truncated', parsed.attachments.length, rawSize, settings.maxEmailSize);
    } else if (env.BUCKET && settings.attachmentSaveEnabled && parsed.attachments.length > 0) {
        const bucket = env.BUCKET;
        // The puts are independent: run them concurrently and let one failure
        // drop only its own attachment.
        const stored = await Promise.all(
            parsed.attachments.map(async (attachment): Promise<AttachmentRecord | null> => {
                // A limit of zero (or less) means "no limit": storing nothing
                // silently would be a worse default than honouring every attachment.
                if (settings.attachmentMaxSize > 0 && attachment.content.byteLength > settings.attachmentMaxSize) {
                    console.error(
                        '[email] attachment.skip.oversize',
                        attachment.filename,
                        attachment.content.byteLength,
                    );
                    return null;
                }
                const attachmentId = crypto.randomUUID();
                const key = `attachments/${id}/${attachmentId}/${attachment.filename}`;
                try {
                    await bucket.put(key, attachment.content, {
                        httpMetadata: { contentType: attachment.mimetype },
                    });
                } catch (e) {
                    console.error('[email] attachment.store.failed', attachment.filename, (e as Error).message);
                    return null;
                }
                return {
                    id: attachmentId,
                    email_id: id,
                    filename: attachment.filename,
                    mimetype: attachment.mimetype,
                    size: attachment.content.byteLength,
                    content_id: attachment.contentId,
                    disposition: attachment.disposition,
                    r2_key: key,
                };
            }),
        );
        attachmentRecords.push(...stored.filter((record): record is AttachmentRecord => record !== null));
    }

    let bodyHtml = parsed.html;
    let bodyText: string | null = parsed.text;
    let bodyHtmlKey: string | null = null;
    let bodyTextKey: string | null = null;
    if (env.BUCKET) {
        if (bodyHtml && bodyHtml.length > BODY_INLINE_LIMIT) {
            bodyHtmlKey = `bodies/${id}/body.html`;
            await env.BUCKET.put(bodyHtmlKey, bodyHtml);
            bodyHtml = null;
        }
        if (bodyText && bodyText.length > BODY_INLINE_LIMIT) {
            bodyTextKey = `bodies/${id}/body.txt`;
            await env.BUCKET.put(bodyTextKey, bodyText);
            bodyText = null;
        }
    }

    await dao.insertEmail(
        {
            ...parsed,
            html: bodyHtml,
            text: bodyText ?? '',
        },
        {
            id,
            folder,
            size: rawSize,
            bodyHtmlKey,
            bodyTextKey,
            storedAttachments: attachmentRecords.length,
        },
    );
    await dao.insertAttachments(id, attachmentRecords);

    const stored = await dao.getEmail(id);
    if (!stored) {
        throw new Error('Failed to persist email');
    }
    return stored;
}

/** One delivered notification: which chat got it and the Telegram message id. */
export interface TelegramNotification {
    chatId: string;
    messageId: number;
}

export async function sendMailToTelegram(mail: EmailRecord, env: Environment): Promise<TelegramNotification[]> {
    const { TELEGRAM_TOKEN, TELEGRAM_ID, TELEGRAM_THREAD_ID } = env;
    const threadId = TELEGRAM_THREAD_ID?.trim() ? Number(TELEGRAM_THREAD_ID) : undefined;
    if (threadId !== undefined && (!Number.isSafeInteger(threadId) || threadId <= 0)) {
        throw new Error('TELEGRAM_THREAD_ID must be a positive integer');
    }
    // The email context has no request, so without a DOMAIN variable the host
    // falls back to the one remembered by `/init`. Empty means it was never
    // discovered and renderEmailListMode omits the Mini App button.
    if (!env.DOMAIN) {
        env.DOMAIN = (await loadDiscoveredDomain(env)) ?? '';
    }
    const settings = await loadSettings(env);
    const hydrated = await hydrateEmail(mail, env.BUCKET);
    const api = createTelegramBotAPI(TELEGRAM_TOKEN);
    const chats = TELEGRAM_ID.split(',')
        .map(item => item.trim())
        .filter(Boolean);
    // Only numeric positive chat ids are private chats, which are the only
    // chats that accept a `web_app` button for the Open action. Group,
    // channel and @username destinations omit it rather than risk a send
    // failure with an unsupported button.
    const outcomes = await Promise.allSettled(
        chats.map(async (id): Promise<TelegramNotification> => {
            const req = await renderEmailListMode(hydrated, env, settings, {
                chatType: /^\d+$/.test(id) ? 'private' : 'group',
            });
            const msg = await api.sendMessageWithReturns({
                chat_id: id,
                ...req,
                message_thread_id: /^-\d+$/.test(id) ? threadId : undefined,
            });
            if (!msg.ok) {
                throw new Error(`Telegram notification failed: ${JSON.stringify(msg)}`);
            }
            return { chatId: id, messageId: msg.result.message_id };
        }),
    );
    // One failing chat must not lose the message ids of the others.
    for (const outcome of outcomes) {
        if (outcome.status === 'rejected') {
            console.error('[email] telegram.notify.failed', mail.id, outcome.reason);
        }
    }
    return outcomes
        .filter((outcome): outcome is PromiseFulfilledResult<TelegramNotification> => outcome.status === 'fulfilled')
        .map(outcome => outcome.value);
}

/**
 * Background half of a delivery. The email is already persisted when this
 * runs, so a slow or failing Telegram API is only logged — it can no longer
 * delay the mail or bounce it back to the sender.
 */
async function notifyTelegram(mail: EmailRecord, env: Environment, dao: Dao): Promise<void> {
    try {
        const notifications = await sendMailToTelegram(mail, env);
        await Promise.all(
            notifications.map(({ chatId, messageId }) => dao.saveTelegramMessage(messageId, chatId, mail.id)),
        );
    } catch (e) {
        console.error('[email] telegram.notify.failed', mail.id, (e as Error).message);
    }
}

export async function emailHandler(
    message: ForwardableEmailMessage,
    env: Environment,
    ctx: ExecutionContext,
): Promise<void> {
    const dao = new Dao(env.DB);
    // A database that is behind fails every query on a missing column; say so
    // once per isolate instead of only surfacing raw SQLITE_ERRORs.
    await warnIfSchemaOutdated(env.DB);
    const settings = await loadSettings(env);
    const isBlock = await isMessageBlock(message, env);

    // Reject the email. Done before identity resolution so a rejected message
    // without a `Message-ID` is not fully buffered just to be thrown away.
    if (isBlock && settings.blockPolicy.includes('reject')) {
        message.setReject('Blocked');
        return;
    }

    const identity = await resolveMessageIdentity(message, settings);
    const id = identity.id;

    // Delivery journal keyed by the delivery identity. Email Routing re-runs the
    // worker whenever the handler throws, so the journal is what turns a retry
    // into a resumption instead of a duplicate forward, row or notification.
    // Claiming first (atomically) means a retry after a crash mid-delivery sees
    // what the previous attempt already finished and continues from there.
    const journalId = id;
    const status = await dao.claimMailStatus(journalId);
    const forwarded = new Set(JSON.parse(status.forwards) as string[]);
    const storedFlag = status.stored === 1;

    // Forward to email; one bad address only skips itself.
    const blockForward = isBlock && settings.blockPolicy.includes('forward');
    const forwardList = blockForward || !settings.forwardEnabled ? [] : settings.forwardList;
    for (const forward of forwardList) {
        const address = forward.trim();
        if (!address || forwarded.has(address)) {
            continue;
        }
        try {
            await message.forward(address);
            forwarded.add(address);
            await dao.upsertMailStatus(journalId, { forwards: [...forwarded] });
        } catch (e) {
            console.error('[email] forward.failed', address, (e as Error).message);
        }
    }

    // Parse and persist. Persisting is the transaction boundary: a failure here
    // propagates so Email Routing retries delivery, while `stored` keeps that
    // retry from parsing and inserting a second time.
    //
    // The residual windows are the writes themselves: a crash between the insert
    // and the `stored` write re-parses once and then finds the row by identity, so
    // nothing is duplicated; a crash between `stored` and the notification drops
    // that one push (at-most-once for the push, at-least-once for the stored mail).
    const blockTelegram = isBlock && settings.blockPolicy.includes('telegram');
    if (!storedFlag || !status.telegram) {
        const folder = isBlock ? 'spam' : 'inbox';
        let stored: EmailRecord;
        // Reuse the row a previous attempt persisted. If it is gone (purged mail,
        // or a cleanup that removed the row but not its journal entry) fall through
        // and store it again rather than throwing: throwing would make Email
        // Routing retry a delivery that can never succeed, and at-least-once is
        // the delivery guarantee this handler promises for stored mail.
        const existing = storedFlag ? await dao.getEmailByMessageId(id) : null;
        if (existing) {
            stored = existing;
        } else {
            const parsed = await parseEmail(message, settings.maxEmailSize, settings.maxEmailSizePolicy, {
                messageId: id,
                rawBytes: identity.rawBytes ?? undefined,
            });
            const same = await dao.getEmailByMessageId(parsed.messageId);
            if (same && same.size === message.rawSize) {
                stored = same;
            } else {
                stored = await persistEmail(env, dao, parsed, folder, message.rawSize, settings);
            }
            await dao.upsertMailStatus(journalId, { stored: true });
        }
        // A redelivery can arrive after the block policy changed; keep the row's
        // folder in step with how this delivery classified it.
        if (stored.folder !== folder) {
            await dao.updateEmailFlags(stored.id, { folder });
            stored = { ...stored, folder };
        }
        if (!status.telegram && !blockTelegram) {
            await dao.upsertMailStatus(journalId, { stored: true, telegram: true });
            ctx.waitUntil(notifyTelegram(stored, env, dao));
        }
    }
}
