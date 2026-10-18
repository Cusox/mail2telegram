import type { ForwardableEmailMessage } from '@cloudflare/workers-types';
import type { Environment } from '../src/types';
import { env } from 'cloudflare:test';

interface BuildEmailInput {
    messageId?: string;
    subject?: string;
    from?: string;
    to?: string;
    body?: string;
    /** Extra raw MIME already serialised, appended verbatim after the headers. */
    rawBody?: string;
    extraHeaders?: Record<string, string>;
}

export interface BuiltEmail {
    message: ForwardableEmailMessage;
    forwarded: string[];
    rejected: string[];
}

/** Minimal RFC822 message with matching `Headers`, so both parsers agree. */
export function buildEmail(input: BuildEmailInput = {}): BuiltEmail {
    const from = input.from ?? 'sender@example.com';
    const to = input.to ?? 'inbox@example.com';
    const subject = input.subject ?? 'Hello';
    const body = input.rawBody ?? input.body ?? 'Hello body';
    const headers = new Headers();
    const lines: string[] = [];
    if (input.messageId !== undefined) {
        headers.set('Message-ID', input.messageId);
        lines.push(`Message-ID: ${input.messageId}`);
    }
    headers.set('Subject', subject);
    lines.push(`Subject: ${subject}`);
    headers.set('From', from);
    lines.push(`From: ${from}`);
    headers.set('To', to);
    lines.push(`To: ${to}`);
    for (const [key, value] of Object.entries(input.extraHeaders ?? {})) {
        headers.set(key, value);
        lines.push(`${key}: ${value}`);
    }
    const raw = `${lines.join('\r\n')}\r\n\r\n${body}`;
    const bytes = new TextEncoder().encode(raw);
    const forwarded: string[] = [];
    const rejected: string[] = [];
    const message = {
        from,
        to,
        headers,
        rawSize: bytes.byteLength,
        raw: new Response(bytes).body as ReadableStream<Uint8Array>,
        forward: async (address: string) => {
            forwarded.push(address);
        },
        setReject: (reason: string) => {
            rejected.push(reason);
        },
    } as unknown as ForwardableEmailMessage;
    return { message, forwarded, rejected };
}

/** Environment backed by the Miniflare D1 and R2 bindings. */
export function testEnv(overrides: Partial<Environment> = {}): Environment {
    const bindings = env as unknown as { DB: Environment['DB']; BUCKET: Environment['BUCKET'] };
    return {
        TELEGRAM_TOKEN: 'test-token',
        TELEGRAM_ID: '1001',
        DOMAIN: 'mail2telegram.test.workers.dev',
        FORWARD_LIST: '',
        BLOCK_LIST: '',
        WHITE_LIST: '',
        BLOCK_POLICY: 'reject',
        DB: bindings.DB,
        BUCKET: bindings.BUCKET,
        ...overrides,
    };
}

/** Wipe every table between tests so counts are independent of ordering. */
export async function resetStorage(): Promise<void> {
    const bindings = env as unknown as { DB: Environment['DB'] };
    for (const table of [
        'attachments',
        'telegram_messages',
        'telegram_starts',
        'mail_status',
        'emails',
        'addresses',
        'settings',
    ]) {
        await bindings.DB.prepare(`DELETE FROM ${table}`).run();
    }
}

/** Intercepts outbound Telegram calls and records how many were sent. */
export function mockTelegramFetch(): {
    readonly calls: number;
    readonly bodies: string[];
    /** Makes the next call answer `{ok:false}`, as Telegram does on rejection. */
    rejectNext: () => void;
    restore: () => void;
} {
    let calls = 0;
    const bodies: string[] = [];
    let reject = false;
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls += 1;
        bodies.push(String(init?.body ?? ''));
        if (reject) {
            reject = false;
            return Response.json({ ok: false, description: 'Bad Request: bad secret token' }, { status: 400 });
        }
        if (String(input).endsWith('/getMe')) {
            return Response.json({
                ok: true,
                result: { id: 123, is_bot: true, first_name: 'Mail', username: 'MailBot' },
            });
        }
        return Response.json({ ok: true, result: { message_id: 1000 + calls } });
    }) as typeof fetch;
    return {
        get calls() {
            return calls;
        },
        get bodies() {
            return bodies;
        },
        rejectNext: () => {
            reject = true;
        },
        restore: () => {
            globalThis.fetch = original;
        },
    };
}
