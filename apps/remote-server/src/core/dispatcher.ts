import { randomUUID } from 'crypto';
import type { Context as HonoContext } from 'hono';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from './types.js';
import { engine } from './engine-singleton.js';
import { sessionStore } from './session-store.js';
import { clarificationQueue } from './clarification-queue.js';
import { processIncomingCommand, type CommandResult } from './chat-commands.js';
import { memoryIntegration } from './memory-integration.js';
import {
  hasActiveRun,
  setActiveRun,
  clearActiveRun,
  getActiveStreamId as getActiveStreamIdFromStore,
} from './active-run-store.js';

interface CompactionSnapshot {
  attempt: number;
  trigger: 'pre-loop' | 'length-retry';
  reason?: string;
  forced: boolean;
  strategy: 'summary' | 'summary-too-large' | 'fallback';
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
}


/**
 * Main entry point for all platform webhook routes.
 *
 * Each platform route does:
 *   app.post('/webhooks/feishu', (c) => dispatch(feishuAdapter, c))
 *
 * The dispatcher handles:
 *   - Signature verification
 *   - Payload parsing (dedup, clarification routing happens inside parseIncoming)
 *   - Immediate ack (for platforms with response time limits)
 *   - Async agent execution
 */
export async function dispatch(adapter: PlatformAdapter, c: HonoContext): Promise<Response> {
  // 1. Verify webhook signature
  const valid = await adapter.verifyRequest(c.req);
  if (!valid) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // 2. Parse incoming message
  const incoming = await adapter.parseIncoming(c.req);
  if (!incoming) {
    // null means: heartbeat, deduped event, or clarification answer already handled
    return adapter.ackRequest(c, null);
  }

  // 3. Acknowledge immediately (Feishu/Telegram require fast response)
  // Pass incoming so the adapter can include per-request data (e.g. streamId) in the ack
  const response = adapter.ackRequest(c, incoming);

  // 4. Run agent asynchronously — do NOT await here
  runAgentAsync(adapter, incoming).catch((err) => {
    console.error(`[dispatcher] Unhandled error for ${incoming.platformKey}:`, err);
  });

  return response;
}

async function runAgentAsync(adapter: PlatformAdapter, incoming: IncomingMessage): Promise<void> {
  const { platformKey, forceNewSession } = incoming;
  let text = incoming.text;

  // Start streaming feedback early for long-running slash commands (for better UX on Feishu/Telegram)
  let commandHandle: StreamHandle | null = null;
  let commandStreamId: string | null = null;

  const getCommandStreamId = (): string => {
    if (commandStreamId) {
      return commandStreamId;
    }

    commandStreamId = incoming.streamId ?? randomUUID();
    return commandStreamId;
  };

  if (shouldStreamCommandProgress(text) && !hasActiveRun(platformKey)) {
    try {
      commandHandle = await adapter.createStreamHandle(incoming, getCommandStreamId());
      await commandHandle.onText('🧩 正在压缩上下文，请稍候...');
    } catch (err) {
      console.error(`[dispatcher] Failed to stream command progress for ${incoming.platformKey}:`, err);
      commandHandle = null;
    }
  }

  // Handle slash commands before entering agent run loop
  let commandResult: CommandResult;
  try {
    commandResult = await processIncomingCommand(incoming);
  } catch (err) {
    const handle = commandHandle ?? await adapter.createStreamHandle(incoming, getCommandStreamId());
    await handle.onError(err instanceof Error ? err : new Error(String(err)));
    return;
  }

  if (commandResult.type === 'handled') {
    const handle = commandHandle ?? await adapter.createStreamHandle(incoming, getCommandStreamId());
    await handle.onDone(commandResult.message);
    return;
  }

  if (commandResult.type === 'handled_silent') {
    return;
  }

  if (commandResult.type === 'transformed') {
    text = commandResult.text;
  }

  // Prevent concurrent runs for the same user
  if (hasActiveRun(platformKey)) {
    const handle = await adapter.createStreamHandle(incoming, 'busy');
    await handle.onError(new Error('正在处理上一条消息，请稍候再试。'));
    return;
  }

  // Use pre-allocated streamId if the adapter set one (e.g. Web adapter), else generate
  const streamId = incoming.streamId ?? randomUUID();
  const ac = new AbortController();
  setActiveRun(platformKey, { streamId, ac, startedAt: Date.now() });

  let sessionId: string | undefined;
  let handle: StreamHandle | null = null;
  const compactionEvents: CompactionSnapshot[] = [];

  try {
    const result = await sessionStore.getOrCreate(platformKey, forceNewSession);
    sessionId = result.sessionId;
    const context = result.context;

    handle = await adapter.createStreamHandle(incoming, streamId);

    // Append the user's message to context
    context.messages.push({ role: 'user', content: text });

    const finalText = await memoryIntegration.withRunContext(
      {
        platformKey,
        sessionId,
        userText: text,
      },
      async () => engine.run(context, {
        abortSignal: ac.signal,
        onText: (delta) => {
          handle?.onText(delta).catch(console.error);
        },
        onToolCall: (toolCall) => {
          handle?.onToolCall(toolCall.toolName ?? toolCall.name ?? 'unknown', toolCall.args ?? toolCall.input ?? {}).catch(console.error);
        },
        onToolResult: (toolResult) => {
          handle?.onToolResult?.(toolResult).catch(console.error);
        },
        onResponse: (messages) => {
          for (const msg of messages) {
            context.messages.push(msg);
          }
        },
        onCompacted: (newMessages, event) => {
          if (event) {
            compactionEvents.push({
              attempt: event.attempt,
              trigger: event.trigger,
              reason: event.reason,
              forced: event.forced,
              strategy: event.strategy,
              beforeMessageCount: event.beforeMessageCount,
              afterMessageCount: event.afterMessageCount,
              beforeEstimatedTokens: event.beforeEstimatedTokens,
              afterEstimatedTokens: event.afterEstimatedTokens,
            });

            handle
              ?.onToolCall('compact_context', {
                attempt: event.attempt,
                trigger: event.trigger,
                reason: event.reason ?? event.strategy,
                forced: event.forced,
                tokens: `${event.beforeEstimatedTokens} -> ${event.afterEstimatedTokens}`,
                messages: `${event.beforeMessageCount} -> ${event.afterMessageCount}`,
              })
              .catch(console.error);
          }

          context.messages = newMessages;
        },
        onClarificationRequest: async (request) => {
          await handle?.onClarification(request);
          return clarificationQueue.waitForAnswer(streamId, request);
        },
      }),
    );

    await sessionStore.save(sessionId, context);
    await handle.onDone(finalText);

    if (compactionEvents.length > 0) {
      console.info(
        `[dispatcher] compacted ${platformKey} session=${sessionId ?? 'unknown'} details=${formatCompactionEvents(compactionEvents)}`,
      );
    }

  } catch (err) {
    // Cancel any pending clarification for this stream
    clarificationQueue.cancel(streamId, 'Agent run failed');

    const runError = err instanceof Error ? err : new Error(String(err));

    // Reuse the original handle whenever available to preserve adapter state
    try {
      if (!handle) {
        handle = await adapter.createStreamHandle(incoming, streamId);
      }

      if (ac.signal.aborted || isAbortError(runError)) {
        await handle.onDone('⏹️ 当前任务已停止。');
      } else {
        await handle.onError(runError);
      }
    } catch (sendErr) {
      console.error(`[dispatcher] Could not send error to ${platformKey}:`, sendErr);
      console.error('[dispatcher] Original run error:', runError);
    }
  } finally {
    clearActiveRun(platformKey);
  }
}


function formatCompactionEvents(events: CompactionSnapshot[]): string {
  return events
    .map((event) => {
      const reason = event.reason ?? event.strategy;
      return `#${event.attempt} ${event.trigger} ${reason} msgs:${event.beforeMessageCount}->${event.afterMessageCount} tokens:${event.beforeEstimatedTokens}->${event.afterEstimatedTokens}`;
    })
    .join(' | ');
}

function shouldStreamCommandProgress(text: string): boolean {
  const trimmed = text.trim().toLowerCase();
  if (!trimmed.startsWith('/')) {
    return false;
  }

  const command = trimmed.slice(1).split(/\s+/, 1)[0] ?? '';
  return command === 'compact';
}

function isAbortError(error: Error): boolean {
  const text = `${error.name} ${error.message}`.toLowerCase();
  return text.includes('abort') || text.includes('cancel');
}

/** Expose activeRuns for adapters that need to look up the current streamId by platformKey. */
export function getActiveStreamId(platformKey: string): string | undefined {
  return getActiveStreamIdFromStore(platformKey);
}
