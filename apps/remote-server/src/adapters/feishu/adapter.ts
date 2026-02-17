import type { HonoRequest, Context as HonoContext } from 'hono';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from '../../core/types.js';
import type { ClarificationRequest } from '../../core/types.js';
import { clarificationQueue } from '../../core/clarification-queue.js';
import { getActiveStreamId } from '../../core/dispatcher.js';
import {
  FeishuClient,
  buildThinkingCard,
  buildProgressCard,
  buildDoneCard,
  buildErrorCard,
} from './client.js';

/**
 * Feishu (Lark) adapter.
 *
 * Streaming: sends an interactive card, then patches it with accumulated text (debounced 500ms).
 *
 * Clarification: sends a plain text question message.
 *   User's next message is intercepted in parseIncoming via the clarification queue.
 *
 * Feishu-specific requirements:
 *   - URL verification: respond with { challenge } immediately
 *   - Event deduplication: Feishu retries unacknowledged events; use a 70s UUID cache
 *   - Fast response: must respond within ~3 seconds or Feishu retries
 *   - Signature verification: X-Lark-Signature header (if FEISHU_ENCRYPT_KEY is set)
 */

function createFeishuClient(): FeishuClient {
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error('FEISHU_APP_ID and FEISHU_APP_SECRET are required');
  return new FeishuClient(appId, appSecret);
}

// Deduplication cache: eventId -> timestamp
const dedupCache = new Map<string, number>();
const DEDUP_TTL = 70_000; // 70s

function isDuplicate(eventId: string): boolean {
  const ts = dedupCache.get(eventId);
  if (ts && Date.now() - ts < DEDUP_TTL) return true;
  dedupCache.set(eventId, Date.now());
  if (dedupCache.size > 500) {
    const cutoff = Date.now() - DEDUP_TTL;
    for (const [id, t] of dedupCache) {
      if (t < cutoff) dedupCache.delete(id);
    }
  }
  return false;
}

export class FeishuAdapter implements PlatformAdapter {
  name = 'feishu';
  private client = createFeishuClient();

  // Map from platformKey -> { chatId, chatIdType }
  // Set in parseIncoming, read in createStreamHandle
  private chatMeta = new Map<string, { chatId: string; chatIdType: 'open_id' | 'chat_id' }>();

  // Most recent URL verification challenge (set in parseIncoming, consumed in ackRequest)
  private pendingChallenge: string | null = null;

  verifyRequest(req: HonoRequest): boolean {
    const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
    if (!encryptKey) return true; // Signature verification not configured

    const signature = req.header('x-lark-signature');
    const timestamp = req.header('x-lark-request-timestamp');
    const nonce = req.header('x-lark-request-nonce');
    if (!signature || !timestamp || !nonce) return false;

    // Note: We cannot read the body here (it gets consumed). Signature verification
    // requires the raw body, which must be read in parseIncoming before verification.
    // For simplicity, we defer full signature verification to parseIncoming.
    // Return true here; parseIncoming can reject invalid events by returning null.
    return true;
  }

  async parseIncoming(req: HonoRequest): Promise<IncomingMessage | null> {
    let raw: string;
    let body: Record<string, unknown>;
    try {
      raw = await req.text();
      body = JSON.parse(raw);
    } catch {
      return null;
    }

    // --- Signature verification (deferred from verifyRequest) ---
    const encryptKey = process.env.FEISHU_ENCRYPT_KEY;
    if (encryptKey) {
      const signature = req.header('x-lark-signature') ?? '';
      const timestamp = req.header('x-lark-request-timestamp') ?? '';
      const nonce = req.header('x-lark-request-nonce') ?? '';
      if (!this.client.verifySignature(timestamp, nonce, encryptKey, raw, signature)) {
        return null; // Invalid signature — treat as null (ackRequest returns generic 200)
      }
    }

    // --- URL verification challenge ---
    if (body['type'] === 'url_verification') {
      this.pendingChallenge = body['challenge'] as string;
      return null; // ackRequest will respond with the challenge
    }

    const header = body['header'] as Record<string, string> | undefined;
    const event = body['event'] as Record<string, unknown> | undefined;
    if (!header || !event) return null;

    // Event deduplication
    const eventId = header['event_id'];
    if (eventId && isDuplicate(eventId)) return null;

    // Only handle text message receive events
    if (header['event_type'] !== 'im.message.receive_v1') return null;

    const sender = event['sender'] as Record<string, Record<string, string>> | undefined;
    const message = event['message'] as Record<string, unknown> | undefined;

    const openId = sender?.['sender_id']?.['open_id'];
    if (!openId) return null;

    const msgType = message?.['message_type'] as string;
    if (msgType !== 'text') return null;

    let text: string;
    try {
      const content = JSON.parse(message?.['content'] as string ?? '{}') as { text?: string };
      text = content.text?.trim() ?? '';
    } catch {
      return null;
    }
    if (!text) return null;

    const chatId = message?.['chat_id'] as string | undefined;
    const platformKey = `feishu:${openId}`;

    // Store chat metadata for createStreamHandle
    this.chatMeta.set(platformKey, {
      chatId: chatId ?? openId,
      chatIdType: chatId ? 'chat_id' : 'open_id',
    });

    // Check for pending clarification — route this message as the answer
    const activeStreamId = getActiveStreamId(platformKey);
    if (activeStreamId && clarificationQueue.hasPending(activeStreamId)) {
      const pending = clarificationQueue.getPending(activeStreamId);
      if (pending) {
        clarificationQueue.submitAnswer(activeStreamId, pending.request.id, text);
        const sendTo = chatId ?? openId;
        const idType: 'chat_id' | 'open_id' = chatId ? 'chat_id' : 'open_id';
        await this.client.sendTextMessage(sendTo, idType, `✅ Got it: "${text}"`).catch(console.error);
      }
      return null;
    }

    return { platformKey, text };
  }

  ackRequest(c: HonoContext, _incoming: IncomingMessage | null): Response {
    // Consume and respond to URL verification challenge
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
    // Capture client in closure to avoid `this` context loss inside returned object
    const { client } = this;

    let cardMessageId: string | null = null;
    let accumulatedText = '';
    let debounceHandle: ReturnType<typeof setTimeout> | null = null;

    // Send initial "thinking" card
    try {
      const msg = await client.sendCardMessage(chatId, idType, buildThinkingCard());
      cardMessageId = msg.message_id;
    } catch (err) {
      console.error('[feishu] Failed to send thinking card:', err);
    }

    const scheduleUpdate = () => {
      if (debounceHandle) clearTimeout(debounceHandle);
      debounceHandle = setTimeout(async () => {
        if (cardMessageId && accumulatedText) {
          await client.updateCardMessage(cardMessageId, buildProgressCard(accumulatedText)).catch(console.error);
        }
      }, 500);
    };

    return {
      async onText(delta) {
        accumulatedText += delta;
        scheduleUpdate();
      },

      async onToolCall(_name, _input) {
        // Feishu card already shows progress text — no-op
      },

      async onClarification(req: ClarificationRequest) {
        const question = req.context
          ? `${req.question}\n\n_Context: ${req.context}_`
          : req.question;
        await client.sendTextMessage(chatId, idType, `❓ ${question}`).catch(console.error);
      },

      async onDone(result) {
        if (debounceHandle) clearTimeout(debounceHandle);
        if (cardMessageId) {
          await client.updateCardMessage(cardMessageId, buildDoneCard(result)).catch(console.error);
        } else {
          await client.sendTextMessage(chatId, idType, result || '✅ Done').catch(console.error);
        }
      },

      async onError(err) {
        if (debounceHandle) clearTimeout(debounceHandle);
        if (cardMessageId) {
          await client.updateCardMessage(cardMessageId, buildErrorCard(err.message)).catch(console.error);
        } else {
          await client.sendTextMessage(chatId, idType, `❌ ${err.message}`).catch(console.error);
        }
      },
    };
  }
}

export const feishuAdapter = new FeishuAdapter();
