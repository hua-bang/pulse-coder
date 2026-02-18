import * as lark from '@larksuiteoapi/node-sdk';
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
 * Feishu (Lark) adapter using the official @larksuiteoapi/node-sdk.
 *
 * The SDK handles:
 *   - tenant_access_token refresh automatically
 *   - URL verification challenge (via EventDispatcher)
 *   - Payload decryption (if encryptKey is set)
 *   - Event deduplication
 *
 * We bridge EventDispatcher → Hono manually since there's no official Hono adapter.
 * The bridge extracts the parsed event from EventDispatcher and passes it to our
 * dispatcher via a Promise that resolves when the event handler fires.
 */

export class FeishuAdapter implements PlatformAdapter {
  name = 'feishu';

  // SDK Client — handles token refresh, retries, domain routing
  private larkClient = createLarkClient();

  // EventDispatcher — handles URL verification, decryption, dedup, and event routing
  private eventDispatcher = new lark.EventDispatcher({
    encryptKey: process.env.FEISHU_ENCRYPT_KEY ?? '',
    verificationToken: process.env.FEISHU_VERIFICATION_TOKEN ?? '',
  });

  // Map from platformKey -> { chatId, chatIdType }
  // Set during event dispatch, read in createStreamHandle
  private chatMeta = new Map<string, { chatId: string; chatIdType: 'open_id' | 'chat_id' }>();

  verifyRequest(_req: HonoRequest): boolean {
    // Signature verification is handled inside EventDispatcher.invoke()
    return true;
  }

  async parseIncoming(req: HonoRequest): Promise<IncomingMessage | null> {
    const rawBody = await req.text();

    // Collect headers for the SDK (it expects a plain object)
    const headers: Record<string, string> = {};
    req.raw.headers.forEach((value, key) => { headers[key] = value; });

    // Wrap in a Promise so we can extract the event from the EventDispatcher callback
    let resolveIncoming!: (msg: IncomingMessage | null) => void;
    const incomingPromise = new Promise<IncomingMessage | null>((res) => { resolveIncoming = res; });

    // Register the im.message.receive_v1 handler for this invocation
    // The SDK deduplicates events and handles URL verification automatically
    const dispatcher = this.eventDispatcher.register({
      'im.message.receive_v1': async (data) => {
        const openId = data.sender?.sender_id?.open_id;
        const message = data.message;

        if (!openId || message?.message_type !== 'text') {
          resolveIncoming(null);
          return;
        }

        let text: string;
        try {
          const content = JSON.parse(message.content ?? '{}') as { text?: string };
          text = content.text?.trim() ?? '';
        } catch {
          resolveIncoming(null);
          return;
        }

        if (!text) { resolveIncoming(null); return; }

        const chatId = message.chat_id;
        const platformKey = `feishu:${openId}`;

        // Store chat metadata for createStreamHandle
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
          resolveIncoming(null);
          return;
        }

        resolveIncoming({ platformKey, text });
      },
    });

    // Feed the raw request into the SDK dispatcher
    // SDK handles: URL verification challenge, decryption, dedup, signature
    try {
      await dispatcher.invoke({
        headers,
        body: JSON.parse(rawBody),
      } as any);
    } catch (err: any) {
      // URL verification: SDK throws with the challenge value in the message
      // Shape: { code: 0, challenge: '...' } or similar — capture it
      if (err?.challenge) {
        resolveIncoming(null);
        // Store challenge so ackRequest can return it
        this.pendingChallenge = err.challenge as string;
      } else {
        console.error('[feishu] EventDispatcher error:', err);
        resolveIncoming(null);
      }
    }

    return incomingPromise;
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
