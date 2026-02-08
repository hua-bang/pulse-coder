import { type StepResult } from "ai";
import { streamTextAI } from "./ai";
import { maybeCompactContext } from "./compaction";
import { MAX_COMPACTION_ATTEMPTS, MAX_ERROR_COUNT, MAX_STEPS } from "./config";
import type { Context } from "./typings";

export interface LoopOptions {
  onText?: (delta: string) => void;
  onToolCall?: (toolCall: any) => void;
  onToolResult?: (toolResult: any) => void;
  onStepFinish?: (step: StepResult<any>) => void;
  abortSignal?: AbortSignal;
}

async function loop(context: Context, options?: LoopOptions): Promise<string> {
  let errorCount = 0;
  let totalSteps = 0;
  let compactionAttempts = 0;

  while (true) {
    try {
      if (compactionAttempts < MAX_COMPACTION_ATTEMPTS) {
        const { didCompact } = await maybeCompactContext(context);
        if (didCompact) {
          compactionAttempts++;
          continue;
        }
      }

      const result = streamTextAI(context.messages, {
        abortSignal: options?.abortSignal,
        onStepFinish: (step) => {
          options?.onStepFinish?.(step);
        },
        onChunk: ({ chunk }) => {
          if (chunk.type === 'text-delta') {
            options?.onText?.(chunk.text);
          }
          if (chunk.type === 'tool-call') {
            options?.onToolCall?.(chunk);
          }
          if (chunk.type === 'tool-result') {
            options?.onToolResult?.(chunk);
          }
        },
      });

      const [text, steps, finishReason] = await Promise.all([
        result.text,
        result.steps,
        result.finishReason,
      ]);

      totalSteps += steps.length;

      for (const step of steps) {
        if (step.response?.messages?.length) {

          const message = [...step.response.messages]

          context.messages.push(...message);
        }
      }

      if (finishReason === 'stop') {
        return text || 'Task completed.';
      }

      if (finishReason === 'length') {
        if (compactionAttempts < MAX_COMPACTION_ATTEMPTS) {
          const { didCompact } = await maybeCompactContext(context, { force: true });
          if (didCompact) {
            compactionAttempts++;
            continue;
          }
        }
        return text || 'Context limit reached.';
      }

      if (finishReason === 'content-filter') {
        return text || 'Content filtered.';
      }

      if (finishReason === 'error') {
        return text || 'Task failed.';
      }

      if (finishReason === 'tool-calls') {
        if (totalSteps >= MAX_STEPS) {
          return text || 'Max steps reached, task may be incomplete.';
        }

        continue;
      }

      return text || 'Task completed.';
    } catch (error: any) {
      if (options?.abortSignal?.aborted || error?.name === 'AbortError') {
        return 'Request aborted.';
      }

      errorCount++;
      if (errorCount >= MAX_ERROR_COUNT) {
        return `Failed after ${errorCount} errors: ${error?.message ?? String(error)}`;
      }

      if (isRetryableError(error)) {
        const delay = Math.min(2000 * Math.pow(2, errorCount - 1), 30000);
        await sleep(delay);
        continue;
      }

      return `Error: ${error?.message ?? String(error)}`;
    }
  }
}

function isRetryableError(error: any): boolean {
  const status = error?.status ?? error?.statusCode;
  return status === 429 || status === 500 || status === 502 || status === 503;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default loop;
