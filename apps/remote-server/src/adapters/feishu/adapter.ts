import type { HonoRequest, Context as HonoContext } from 'hono';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from '../../core/types.js';
import type { ClarificationRequest } from '../../core/types.js';
import { clarificationQueue } from '../../core/clarification-queue.js';
import { getActiveStreamId } from '../../core/dispatcher.js';
import {
  createLarkClient,
  sendTextMessage,
  sendCardMessage,
  updateCardMessage,
  buildThinkingCard,
  buildProgressCard,
  buildDoneCard,
  buildErrorCard,
} from './client.js';

/**
 * Feishu (Lark) adapter.
 *
 * Uses the SDK client for sending messages (token refresh, retries).
 * Event routing is handled manually by parsing the JSON body directly —
 * the SDK's EventDispatcher.invoke() bridge was unreliable in Hono context
 * ("no undefined handle" — event_type not extractable via the bridge).
 */

export class FeishuAdapter implements PlatformAdapter {
  name = 'feishu';

  // SDK Client — handles token refresh, retries, domain routing
  private larkClient = createLarkClient();

  // Map from platformKey -> { chatId, chatIdType }
  // Set during parseIncoming, read in createStreamHandle
  private chatMeta = new Map<string, { chatId: string; chatIdType: 'open_id' | 'chat_id' }>();

  // Dedup cache — prevent processing the same message_id twice
  private seenMessageIds = new Set<string>();

  verifyRequest(_req: HonoRequest): boolean {
    return true;
  }

  async parseIncoming(req: HonoRequest): Promise<IncomingMessage | null> {
    let body: Record<string, unknown>;
    try {
      body = await req.json() as Record<string, unknown>;
    } catch {
      return null;
    }

    // URL verification
    if (body['type'] === 'url_verification') {
      this.pendingChallenge = body['challenge'] as string;
      return null;
    }

    // Extract event — supports both v1 (type: "event_callback") and v2 (schema: "2.0")
    const event = body['event'] as Record<string, unknown> | undefined;
    if (!event) return null;

    const message = event['message'] as Record<string, unknown> | undefined;
    const sender = event['sender'] as Record<string, unknown> | undefined;
    if (!message || !sender) return null;

    // Dedup by message_id
    const messageId = message['message_id'] as string | undefined;
    if (messageId) {
      if (this.seenMessageIds.has(messageId)) return null;
      this.seenMessageIds.add(messageId);
      if (this.seenMessageIds.size > 500) {
        this.seenMessageIds.delete(this.seenMessageIds.values().next().value!);
      }
    }

    const openId = (sender['sender_id'] as Record<string, unknown> | undefined)?.['open_id'] as string | undefined;
    if (!openId) return null;
    if (message['message_type'] !== 'text') return null;

    let text: string;
    try {
      const content = JSON.parse(message['content'] as string ?? '{}') as { text?: string };
      text = content.text?.trim() ?? '';
    } catch {
      return null;
    }
    if (!text) return null;

    const chatId = message['chat_id'] as string | undefined;
    const chatType = message['chat_type'] as string | undefined; // 'p2p' | 'group'

    // Group chats: only respond when @mentioned
    if (chatType === 'group') {
      const mentions = (message['mentions'] as unknown[] | undefined) ?? [];
      if (mentions.length === 0) return null;
      text = text.replace(/@\S+/g, '').trim();
      if (!text) return null;
    }

    const platformKey = chatType === 'group' && chatId
      ? `feishu:group:${chatId}:${openId}`
      : `feishu:${openId}`;

    this.chatMeta.set(platformKey, {
      chatId: chatId ?? openId,
      chatIdType: chatId ? 'chat_id' : 'open_id',
    });

    // Route to pending clarification if one is waiting
    const activeStreamId = getActiveStreamId(platformKey);
    if (activeStreamId && clarificationQueue.hasPending(activeStreamId)) {
      const pending = clarificationQueue.getPending(activeStreamId);
      if (pending) {
        clarificationQueue.submitAnswer(activeStreamId, pending.request.id, text);
        const sendTo = chatId ?? openId;
        const idType: 'chat_id' | 'open_id' = chatId ? 'chat_id' : 'open_id';
        await sendTextMessage(this.larkClient, sendTo, idType, `✅ Got it: "${text}"`).catch(console.error);
      }
      return null;
    }

    return { platformKey, text };
  }

  // URL verification challenge to return in ackRequest
  private pendingChallenge: string | null = null;

  ackRequest(c: HonoContext, _incoming: IncomingMessage | null): Response {
    if (this.pendingChallenge) {
      const challenge = this.pendingChallenge;
      this.pendingChallenge = null;
      return c.json({ challenge }, 200);
    }
    return c.json({}, 200);
  }

  async createStreamHandle(incoming: IncomingMessage, _streamId: string): Promise<StreamHandle> {
    const meta = this.chatMeta.get(incoming.platformKey);
    const chatId = meta?.chatId ?? incoming.platformKey.replace('feishu:', '');
    const idType = meta?.chatIdType ?? 'open_id';
    const { larkClient } = this;

    // Clean up chatMeta after reading — it's only needed to bridge parseIncoming → createStreamHandle
    this.chatMeta.delete(incoming.platformKey);

    let cardMessageId: string | null = null;
    let accumulatedText = '';
    let debounceHandle: ReturnType<typeof setTimeout> | null = null;

    // Send initial "thinking" card
    try {
      cardMessageId = await sendCardMessage(larkClient, chatId, idType, buildThinkingCard());
    } catch (err) {
      console.error('[feishu] Failed to send thinking card:', err);
    }

    const scheduleUpdate = () => {
      if (debounceHandle) clearTimeout(debounceHandle);
      debounceHandle = setTimeout(async () => {
        if (cardMessageId && accumulatedText) {
          await updateCardMessage(larkClient, cardMessageId, buildProgressCard(accumulatedText)).catch(console.error);
        }
      }, 500);
    };

    return {
      async onText(delta) {
        accumulatedText += delta;
        scheduleUpdate();
      },

      async onToolCall(_name, _input) {
        // Card shows progress text — no-op
      },

      async onClarification(req: ClarificationRequest) {
        const question = req.context
          ? `${req.question}\n\n_Context: ${req.context}_`
          : req.question;
        await sendTextMessage(larkClient, chatId, idType, `❓ ${question}`).catch(console.error);
      },

      async onDone(result) {
        if (debounceHandle) clearTimeout(debounceHandle);
        if (cardMessageId) {
          await updateCardMessage(larkClient, cardMessageId, buildDoneCard(result)).catch(console.error);
        } else {
          await sendTextMessage(larkClient, chatId, idType, result || '✅ Done').catch(console.error);
        }
      },

      async onError(err) {
        if (debounceHandle) clearTimeout(debounceHandle);
        if (cardMessageId) {
          await updateCardMessage(larkClient, cardMessageId, buildErrorCard(err.message)).catch(console.error);
        } else {
          await sendTextMessage(larkClient, chatId, idType, `❌ ${err.message}`).catch(console.error);
        }
      },
    };
  }
}

export const feishuAdapter = new FeishuAdapter();
