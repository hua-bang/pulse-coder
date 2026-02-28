import type { HonoRequest, Context as HonoContext } from 'hono';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from '../../core/types.js';
import type { ClarificationRequest } from '../../core/types.js';
import { clarificationQueue } from '../../core/clarification-queue.js';
import { getActiveStreamId } from '../../core/active-run-store.js';
import { TelegramClient } from './client.js';

/**
 * Telegram adapter.
 *
 * Streaming: sends a placeholder message first, then edits it with accumulated text.
 * Rate limit: Telegram allows ~20 edits/minute per chat → debounce at 1000ms.
 *
 * Clarification: sends a plain text question. User's next message is intercepted
 * in parseIncoming via getActiveStreamId + clarificationQueue.hasPending().
 *
 * Special commands:
 *   /start → welcome/help message (returns null to skip agent run)
 */

function createTelegramClient(): TelegramClient {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  return new TelegramClient(token);
}

export class TelegramAdapter implements PlatformAdapter {
  name = 'telegram';
  private client = createTelegramClient();

  verifyRequest(req: HonoRequest): boolean {
    const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (!secret) return true; // No secret configured
    return req.header('x-telegram-bot-api-secret-token') === secret;
  }

  async parseIncoming(req: HonoRequest): Promise<IncomingMessage | null> {
    let update: { update_id?: number; message?: { chat: { id: number }; from?: { id: number }; text?: string } };
    try {
      update = await req.json();
    } catch {
      return null;
    }

    const msg = update.message;
    if (!msg?.text) return null;

    const chatId = msg.chat.id;
    const text = msg.text.trim();
    const platformKey = `telegram:${chatId}`;

    // Handle /start command — send welcome, skip agent run
    if (text === '/start') {
      await this.client.sendMessage(
        chatId,
        'Hi! I\'m your AI coding assistant.\n\nAvailable commands:\n/help - Show command help\n/ping - Check bot health\n/new - Start a new session\n/restart - Alias of /new\n/clear - Clear current session context\n/reset - Alias of /clear\n/compact - Force compact current session context\n/current - Show current bound session\n/detach - Detach current session binding\n/resume - List recent sessions\n/resume [list] [N] - List recent N sessions (1-30)\n/sessions - Alias of /resume\n/resume <id> - Resume a specific session\n/status - Show current run/session status\n/stop - Stop current running task\n/cancel - Alias of /stop\n/skills list - Show available skills\n/skills <name|index> <message> - Run one message with a skill'
      );
      return null;
    }

    // Check if the user has an active agent run with a pending clarification
    const activeStreamId = getActiveStreamId(platformKey);
    if (activeStreamId && clarificationQueue.hasPending(activeStreamId)) {
      const pending = clarificationQueue.getPending(activeStreamId);
      if (pending) {
        clarificationQueue.submitAnswer(activeStreamId, pending.request.id, text);
        await this.client.sendMessage(chatId, `Got it: "${text}"`);
      }
      return null; // Skip normal agent dispatch
    }

    return { platformKey, text };
  }

  ackRequest(c: HonoContext, _incoming: IncomingMessage | null): Response {
    return c.json({ ok: true }, 200);
  }

  async createStreamHandle(incoming: IncomingMessage, _streamId: string): Promise<StreamHandle> {
    const chatId = parseInt(incoming.platformKey.replace('telegram:', ''), 10);
    // Capture client in closure to avoid `this` context loss inside returned object
    const { client } = this;

    // Send a "thinking" placeholder message
    let thinkingMsgId: number | null = null;
    try {
      const msg = await client.sendMessage(chatId, '⏳ Working on it...');
      thinkingMsgId = msg.message_id;
    } catch (err) {
      console.error('[telegram] Failed to send placeholder message:', err);
    }

    let accumulatedText = '';
    let debounceHandle: ReturnType<typeof setTimeout> | null = null;

    // Debounced edit — max 1 edit/second to stay within Telegram rate limits
    const scheduleEdit = () => {
      if (debounceHandle) clearTimeout(debounceHandle);
      debounceHandle = setTimeout(async () => {
        if (thinkingMsgId && accumulatedText) {
          await client.editMessageText(chatId, thinkingMsgId, accumulatedText).catch(console.error);
        }
      }, 1000);
    };

    return {
      async onText(delta) {
        accumulatedText += delta;
        scheduleEdit();
      },

      async onToolCall(_name, _input) {
        // No-op — placeholder message shows progress
      },

      async onClarification(req: ClarificationRequest) {
        const question = req.context
          ? `${req.question}\n\n_Context: ${req.context}_`
          : req.question;
        await client.sendMessage(chatId, `❓ ${question}`).catch(console.error);
      },

      async onDone(result) {
        if (debounceHandle) clearTimeout(debounceHandle);
        if (thinkingMsgId) {
          await client.editMessageText(chatId, thinkingMsgId, result || '✅ Done').catch(console.error);
        } else {
          await client.sendMessage(chatId, result || '✅ Done').catch(console.error);
        }
      },

      async onError(err) {
        if (debounceHandle) clearTimeout(debounceHandle);
        const errMsg = `❌ Error: ${err.message}`;
        if (thinkingMsgId) {
          await client.editMessageText(chatId, thinkingMsgId, errMsg).catch(console.error);
        } else {
          await client.sendMessage(chatId, errMsg).catch(console.error);
        }
      },
    };
  }
}

export const telegramAdapter = new TelegramAdapter();
