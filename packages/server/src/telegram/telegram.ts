import type * as Telegram from 'telegram-bot-api-types';
import type { EmailRender } from '../mail';
import type { Environment } from '../types';
import { Dao } from '../db';
import { loadSettings } from '../db/settings';
import {
    hydrateEmail,
    renderEmailDebugMode,
    renderEmailListMode,
    renderEmailPreviewMode,
    renderEmailSummaryMode,
    replyToEmail,
} from '../mail';
import { createTelegramBotAPI } from './api';

type TelegramMessageHandler = (message: Telegram.Message) => Promise<Response>;

function logTelegram(event: string, data?: Record<string, unknown>): void {
    console.log(`[telegram] ${event}${data ? ` ${JSON.stringify(data)}` : ''}`);
}

function logTelegramError(event: string, error: unknown, data?: Record<string, unknown>): void {
    const err = error as Error;
    console.error(
        `[telegram] ${event} ${JSON.stringify({
            ...data,
            message: err?.message || String(error),
            stack: err?.stack,
        })}`,
    );
}

async function logTelegramResponse(method: string, response: Response): Promise<void> {
    const data: Record<string, unknown> = {
        method,
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
    };
    if (!response.ok) {
        try {
            data.body = (await response.clone().text()).substring(0, 500);
        } catch (e) {
            data.bodyReadError = (e as Error).message;
        }
    }
    logTelegram('api.response', data);
}

/**
 * True the first time a chat runs /start, then remembered in D1 so the setup
 * prompt is only shown once.
 */
async function consumeFirstStart(env: Environment, chatId: number): Promise<boolean> {
    return await new Dao(env.DB).claimFirstStart(chatId);
}

function handleStartCommand(env: Environment): TelegramMessageHandler {
    return async (msg: Telegram.Message): Promise<Response> => {
        const { TELEGRAM_TOKEN, DOMAIN } = env;
        const isPrivate = msg.chat.type === 'private';
        let first = false;
        // Only private chats can launch the Mini App, so group /start must not
        // consume the first-time flag.
        if (isPrivate) {
            try {
                first = await consumeFirstStart(env, msg.chat.id);
            } catch (e) {
                logTelegramError('start.claim_error', e, { chatId: msg.chat.id });
            }
        }
        const params: Telegram.SendMessageParams = {
            chat_id: msg.chat.id,
            message_thread_id: msg.message_thread_id,
            text: first
                ? 'Welcome! Open the Mini App to finish binding this bot.'
                : 'Open the mail Mini App to browse history, manage lists and settings.',
        };
        if (isPrivate) {
            params.reply_markup = {
                inline_keyboard: [
                    [
                        {
                            text: first ? 'Set Up & Open' : 'Open Mini App',
                            // The setup flag makes the Mini App bind the webhook on load.
                            web_app: {
                                url: `https://${DOMAIN}/#/inbox${first ? '?setup=1' : ''}`,
                            },
                        },
                    ],
                ],
            };
        }
        return await createTelegramBotAPI(TELEGRAM_TOKEN).sendMessage(params);
    };
}

/** Chat ids (or @usernames) allowed to interact with the bot commands. */
function allowedChats(env: Environment): string[] {
    return env.TELEGRAM_ID.split(',')
        .map(item => item.trim())
        .filter(Boolean);
}

/** True when the update comes from a chat the owner configured in TELEGRAM_ID. */
function isAllowedChat(env: Environment, chat: Telegram.Chat): boolean {
    const allowed = allowedChats(env);
    if (allowed.includes(`${chat.id}`)) {
        return true;
    }
    const username = chat.username ? `@${chat.username}`.toLowerCase() : null;
    return username !== null && allowed.some(item => item.toLowerCase() === username);
}

async function handleReplyEmailCommand(message: Telegram.Message, env: Environment): Promise<void> {
    const { TELEGRAM_TOKEN, RESEND_API_KEY, DB } = env;
    const dao = new Dao(DB);
    const api = createTelegramBotAPI(TELEGRAM_TOKEN);
    const reply = async (text: string) => {
        await api.sendMessage({
            chat_id: message.chat.id,
            message_thread_id: message.message_thread_id,
            reply_parameters: {
                message_id: message.message_id,
            },
            text,
        });
    };
    try {
        const messageID = message.reply_to_message?.message_id;
        if (!messageID) {
            return;
        }
        const emailId = await dao.getEmailIdByTelegramMessage(message.chat.id, messageID);
        if (!emailId) {
            return;
        }
        if (!RESEND_API_KEY) {
            logTelegram('reply_email.disabled', { chatId: message.chat.id, messageId: message.message_id });
            await reply('Resend API is not enabled.');
            return;
        }
        if (!message.text) {
            await reply('Please provide a message to resend.');
            return;
        }
        const mail = await dao.getEmail(emailId);
        if (!mail) {
            await reply('Message not found or expired.');
            return;
        }
        logTelegram('reply_email.send', { chatId: message.chat.id, messageId: message.message_id, emailId });
        await replyToEmail(RESEND_API_KEY, mail, message.text);
        try {
            await dao.recordSentReply(mail, message.text);
        } catch (e) {
            // The reply itself went out; only the Sent-folder copy failed.
            logTelegramError('reply_email.record.failed', e, { chatId: message.chat.id, emailId });
        }
        await reply('Reply sent successfully.');
    } catch (e) {
        logTelegramError('reply_email.error', e, { chatId: message.chat.id, messageId: message.message_id });
        await reply((e as Error).message);
    }
}

async function telegramCommandHandler(message: Telegram.Message, env: Environment): Promise<void> {
    logTelegram('message.received', {
        chatId: message?.chat?.id,
        messageId: message?.message_id,
        chatType: message?.chat?.type,
        hasText: !!message?.text,
        isReply: !!message?.reply_to_message,
    });
    // Strangers get no response at all: commands, the Mini App card and the
    // reply-to-email flow are for the chats the owner configured.
    if (!isAllowedChat(env, message.chat)) {
        logTelegram('message.unauthorized_chat', { chatId: message.chat.id, messageId: message.message_id });
        return;
    }
    const text = message.text || '';
    if (text.startsWith('/')) {
        const command = /^\/start(?:@([a-zA-Z0-9_]+))?(?:\s|$)/.exec(text);
        if (!command) {
            return;
        }
        if (command[1]) {
            const bot = await createTelegramBotAPI(env.TELEGRAM_TOKEN).getMeWithReturns();
            if (!bot.ok || bot.result.username?.toLowerCase() !== command[1].toLowerCase()) {
                return;
            }
        }
        logTelegram('command.start', { chatId: message.chat.id, messageId: message.message_id });
        await handleStartCommand(env)(message);
        return;
    }
    if (message.reply_to_message) {
        await handleReplyEmailCommand(message, env);
        return;
    }
    logTelegram('message.ignored', { chatId: message.chat.id, messageId: message.message_id });
}

async function telegramCallbackHandler(callback: Telegram.CallbackQuery, env: Environment): Promise<void> {
    const { TELEGRAM_TOKEN, DB, BUCKET } = env;

    const data = callback.data;
    const callbackId = callback.id;
    const chatId = callback.message?.chat?.id;
    const messageId = callback.message?.message_id;
    const api = createTelegramBotAPI(TELEGRAM_TOKEN);
    const dao = new Dao(DB);

    if (!data || !chatId || !messageId) {
        logTelegram('callback.missing_fields', {
            hasData: !!data,
            hasChatId: !!chatId,
            hasMessageId: !!messageId,
            callbackId,
        });
        return;
    }

    // A button only proves the chat once received a notification: the inline
    // keyboard keeps working after the chat is removed from TELEGRAM_ID, so the
    // allowlist has to be re-checked here exactly like the command path does.
    const chat = callback.message?.chat;
    if (!chat || !isAllowedChat(env, chat)) {
        logTelegram('callback.unauthorized_chat', { chatId, messageId, callbackId });
        return;
    }

    logTelegram('callback.received', { data, callbackId, chatId, messageId });
    const settings = await loadSettings(env);
    // Editing back to the list view re-renders the keyboard, so it needs the
    // same chat type the initial notification used to keep the Open button out
    // of group chats.
    const chatType = callback.message?.chat?.type;
    const renderHandlerBuilder = (render: EmailRender): ((arg: string) => Promise<void>) => {
        return async (arg: string): Promise<void> => {
            const record = await dao.getEmail(arg);
            if (!record) {
                throw new Error('Error: Email not found or expired.');
            }
            const value = await hydrateEmail(record, BUCKET);
            const req = await render(value, env, settings, { chatType });
            const params: Telegram.EditMessageTextParams = {
                chat_id: chatId,
                message_id: messageId,
                ...req,
            };
            const response = await api.editMessageText(params);
            await logTelegramResponse('editMessageText', response);
        };
    };

    const deleteMessage = async (): Promise<void> => {
        const response = await api.deleteMessage({
            chat_id: chatId,
            message_id: messageId,
        });
        await logTelegramResponse('deleteMessage', response);
    };

    const handlers: { [key: string]: (arg: string) => Promise<void> } = {
        p: renderHandlerBuilder(renderEmailPreviewMode),
        l: renderHandlerBuilder(renderEmailListMode),
        s: renderHandlerBuilder(renderEmailSummaryMode),
        delete: deleteMessage,
    };
    // Gate the action, not just the button: a Debug button rendered while DEBUG
    // was on must stop working once the variable is turned off.
    if (env.DEBUG === 'true') {
        handlers.d = renderHandlerBuilder(renderEmailDebugMode);
    }

    const [act, arg] = data.split(/:(.*)/) as [string, string];
    logTelegram('callback.parsed', { data, act, arg, chatId, messageId });
    if (handlers[act]) {
        try {
            await handlers[act](arg);
        } catch (e) {
            logTelegramError('callback.handler.error', e, { data, act, arg, chatId, messageId });
            const response = await api.answerCallbackQuery({
                callback_query_id: callbackId,
                text: (e as Error).message,
                show_alert: true,
            });
            await logTelegramResponse('answerCallbackQuery', response);
        }
        return;
    }
    logTelegram('callback.unknown_action', { data, act, arg, chatId, messageId });
}

export async function telegramWebhookHandler(req: Request, env: Environment): Promise<void> {
    const body = (await req.json()) as Telegram.Update;
    logTelegram('webhook.update', {
        updateId: body?.update_id,
        hasMessage: !!body?.message,
        hasCallbackQuery: !!body?.callback_query,
        keys: body ? Object.keys(body) : [],
    });
    if (body?.message) {
        await telegramCommandHandler(body.message, env);
        return;
    }
    if (body?.callback_query) {
        await telegramCallbackHandler(body.callback_query, env);
        return;
    }
    logTelegram('webhook.unhandled_update', { updateId: body?.update_id, keys: body ? Object.keys(body) : [] });
}
