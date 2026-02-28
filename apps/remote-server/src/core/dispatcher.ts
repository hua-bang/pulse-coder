import { randomUUID } from 'crypto';
import type { Context as HonoContext } from 'hono';
import type { PlatformAdapter, IncomingMessage, StreamHandle } from './types.js';
import { clarificationQueue } from './clarification-queue.js';
import { processIncomingCommand, type CommandResult } from './chat-commands.js';
import { executeAgentTurn, formatCompactionEvents } from './agent-runner.js';
import {
  hasActiveRun,
  setActiveRun,
  clearActiveRun,
  getActiveStreamId as getActiveStreamIdFromStore,
} from './active-run-store.js';

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
  dispatchIncoming(adapter, incoming);

  return response;
}

/**
 * Run a parsed incoming message asynchronously.
 * Useful for non-webhook sources (e.g. Discord DM gateway events).
 */
export function dispatchIncoming(adapter: PlatformAdapter, incoming: IncomingMessage): void {
  runAgentAsync(adapter, incoming).catch((err) => {
    console.error(`[dispatcher] Unhandled error for ${incoming.platformKey}:`, err);
  });
}

async function runAgentAsync(adapter: PlatformAdapter, incoming: IncomingMessage): Promise<void> {
  const { platformKey, forceNewSession } = incoming;
  const memoryKey = incoming.memoryKey ?? platformKey;
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

  let handle: StreamHandle | null = null;

  try {
    handle = await adapter.createStreamHandle(incoming, streamId);

    const turn = await executeAgentTurn({
      platformKey,
      memoryKey,
      forceNewSession,
      userText: text,
      source: 'dispatcher',
      abortSignal: ac.signal,
      callbacks: {
        onText: (delta) => {
          handle?.onText(delta).catch(console.error);
        },
        onToolCall: (toolCall) => {
          handle
            ?.onToolCall(toolCall.toolName ?? toolCall.name ?? 'unknown', toolCall.args ?? toolCall.input ?? {})
            .catch(console.error);
        },
        onToolResult: (toolResult) => {
          handle?.onToolResult?.(toolResult).catch(console.error);
        },
        onCompactionEvent: (event) => {
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
        },
        onClarificationRequest: async (request) => {
          await handle?.onClarification(request);
          return clarificationQueue.waitForAnswer(streamId, request);
        },
      },
    });

    await handle.onDone(turn.resultText);

    if (turn.compactions.length > 0) {
      console.info(
        `[dispatcher] compacted ${platformKey} session=${turn.sessionId} details=${formatCompactionEvents(turn.compactions)}`,
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
