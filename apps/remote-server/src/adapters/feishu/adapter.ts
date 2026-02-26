import type { HonoRequest, Context as HonoContext } from 'hono';
import { existsSync } from 'fs';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from '../../core/types.js';
import type { ClarificationRequest } from '../../core/types.js';
import { clarificationQueue } from '../../core/clarification-queue.js';
import { getActiveStreamId } from '../../core/active-run-store.js';
import { extractGeminiImageResult } from './image-result.js';
import {
  createLarkClient,
  addMessageReaction,
  sendTextMessage,
  sendImageMessage,
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
  private chatMeta = new Map<string, { chatId: string; chatIdType: 'open_id' | 'chat_id'; sourceMessageId?: string }>();

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
    const memoryKey = `feishu:user:${openId}`;

    if (messageId) {
      // Best-effort acknowledgement reaction for accepted user messages.
      addMessageReaction(messageId, 'Get').catch((err) => {
        console.error('[feishu] Failed to add Get reaction:', err);
      });
    }

    this.chatMeta.set(platformKey, {
      chatId: chatId ?? openId,
      chatIdType: chatId ? 'chat_id' : 'open_id',
      sourceMessageId: messageId,
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

    return { platformKey, memoryKey, text };
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
    const sourceMessageId = meta?.sourceMessageId;
    const { larkClient } = this;

    // Clean up chatMeta after reading — it's only needed to bridge parseIncoming → createStreamHandle
    this.chatMeta.delete(incoming.platformKey);

    let cardMessageId: string | null = null;
    let accumulatedText = '';
    let latestToolHint = '';

    const PROGRESS_UPDATE_INTERVAL_MS = 800;
    const HEARTBEAT_INTERVAL_MS = 12000;
    const DOT_ANIMATION_STEP_MS = 4000;
    const runStartedAt = Date.now();

    let throttleHandle: ReturnType<typeof setTimeout> | null = null;
    let heartbeatHandle: ReturnType<typeof setInterval> | null = null;
    let lastProgressUpdateAt = 0;
    let updateChain: Promise<void> = Promise.resolve();
    let finalized = false;

    const queueCardUpdate = (cardFactory: () => object) => {
      if (!cardMessageId || finalized) return;
      updateChain = updateChain.then(async () => {
        if (!cardMessageId || finalized) return;
        await updateCardMessage(larkClient, cardMessageId, cardFactory()).catch(console.error);
      });
    };

    const formatElapsed = (): string => {
      const totalSeconds = Math.max(0, Math.floor((Date.now() - runStartedAt) / 1000));
      const minutes = Math.floor(totalSeconds / 60);
      const seconds = totalSeconds % 60;
      return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
    };

    const renderProgressText = (): string => {
      const dotCount = 2 + Math.floor((Date.now() - runStartedAt) / DOT_ANIMATION_STEP_MS) % 3;
      const loadingTitle = `Pulse 努力生成中${'.'.repeat(dotCount)}`;
      const detailText = accumulatedText
        ? (latestToolHint ? `${latestToolHint}\n\n${accumulatedText}` : accumulatedText)
        : latestToolHint;

      return detailText
        ? `${loadingTitle}\n\n${detailText}\n\n⏱️ Elapsed: ${formatElapsed()}`
        : `${loadingTitle}\n\n⏱️ Elapsed: ${formatElapsed()}`;
    };

    const clearScheduledProgress = () => {
      if (throttleHandle) {
        clearTimeout(throttleHandle);
        throttleHandle = null;
      }
    };

    const clearHeartbeat = () => {
      if (heartbeatHandle) {
        clearInterval(heartbeatHandle);
        heartbeatHandle = null;
      }
    };

    const scheduleProgressUpdate = (force = false) => {
      if (!cardMessageId || finalized) return;

      const now = Date.now();
      const elapsed = now - lastProgressUpdateAt;

      if (!force && elapsed < PROGRESS_UPDATE_INTERVAL_MS) {
        if (throttleHandle) return;
        throttleHandle = setTimeout(() => {
          throttleHandle = null;
          scheduleProgressUpdate(true);
        }, PROGRESS_UPDATE_INTERVAL_MS - elapsed);
        return;
      }

      lastProgressUpdateAt = now;
      queueCardUpdate(() => buildProgressCard(renderProgressText()));
    };

    const startHeartbeat = () => {
      if (!cardMessageId || finalized || heartbeatHandle) return;
      heartbeatHandle = setInterval(() => {
        scheduleProgressUpdate(true);
      }, HEARTBEAT_INTERVAL_MS);
    };

    const clearProgressState = () => {
      clearScheduledProgress();
      clearHeartbeat();
    };

    // Send initial "thinking" card
    try {
      cardMessageId = await sendCardMessage(larkClient, chatId, idType, buildThinkingCard());
      lastProgressUpdateAt = Date.now();
      startHeartbeat();
    } catch (err) {
      console.error('[feishu] Failed to send thinking card:', err);
    }


    const sentImagePaths = new Set<string>();

    return {
      async onText(delta) {
        accumulatedText += delta;
        scheduleProgressUpdate();
      },

      async onToolCall(name, _input) {
        latestToolHint = `🛠️ Calling tool: \`${name}\``;
        scheduleProgressUpdate();
      },

      async onToolResult(toolResult) {
        const imageResult = extractGeminiImageResult(toolResult);
        if (!imageResult) {
          return;
        }

        if (!existsSync(imageResult.outputPath) || sentImagePaths.has(imageResult.outputPath)) {
          return;
        }

        sentImagePaths.add(imageResult.outputPath);

        try {
          await sendImageMessage(chatId, idType, imageResult.outputPath, imageResult.mimeType);
          latestToolHint = '🖼️ Image generated and sent to Feishu';
          scheduleProgressUpdate(true);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error('[feishu] Failed to send generated image:', message);
          latestToolHint = `⚠️ Image generated but sending failed: ${message}`;
          scheduleProgressUpdate(true);
        }
      },

      async onClarification(req: ClarificationRequest) {
        const question = req.context
          ? `${req.question}\n\n_Context: ${req.context}_`
          : req.question;
        await sendTextMessage(larkClient, chatId, idType, `❓ ${question}`).catch(console.error);
      },

      async onDone(result) {
        clearProgressState();
        finalized = true;
        await updateChain;

        if (cardMessageId) {
          await updateCardMessage(larkClient, cardMessageId, buildDoneCard(result)).catch(console.error);
        } else {
          await sendTextMessage(larkClient, chatId, idType, result || '✅ Done').catch(console.error);
        }

        if (sourceMessageId) {
          addMessageReaction(sourceMessageId, 'DONE').catch((reactionErr) => {
            console.error('[feishu] Failed to add DONE reaction:', reactionErr);
          });
        }
      },

      async onError(err) {
        clearProgressState();
        finalized = true;
        await updateChain;

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

