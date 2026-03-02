import { ToolSet, type StepResult, type ModelMessage } from "ai";
import type { Context, ClarificationRequest, Tool, LLMProviderFactory, SystemPromptOption, RunContext } from "../shared/types";
import type { EngineHookMap, OnCompactedEvent } from "../plugin/EnginePlugin.js";
import { streamTextAI } from "../ai";
import { maybeCompactContext, type CompactStats } from "../context";
import {
  MAX_COMPACTION_ATTEMPTS,
  MAX_ERROR_COUNT,
  MAX_STEPS
} from "../config/index.js";

/**
 * Hook arrays passed into the loop by Engine.
 * Each array may contain handlers from multiple plugins + EngineOptions.
 */
export interface LoopHooks {
  beforeLLMCall?: Array<EngineHookMap['beforeLLMCall']>;
  afterLLMCall?: Array<EngineHookMap['afterLLMCall']>;
  beforeToolCall?: Array<EngineHookMap['beforeToolCall']>;
  afterToolCall?: Array<EngineHookMap['afterToolCall']>;
  onCompacted?: Array<EngineHookMap['onCompacted']>;
}

export interface CompactionEvent extends CompactStats {
  attempt: number;
  trigger: 'pre-loop' | 'length-retry';
  reason?: string;
}

export interface LoopOptions {
  onText?: (delta: string) => void;
  onToolCall?: (toolCall: any) => void;
  onToolResult?: (toolResult: any) => void;
  onStepFinish?: (step: StepResult<any>) => void;
  onClarificationRequest?: (request: ClarificationRequest) => Promise<string>;
  onCompacted?: (newMessages: ModelMessage[], event?: CompactionEvent) => void;
  onResponse?: (messages: StepResult<ToolSet>['response']['messages']) => void;
  abortSignal?: AbortSignal;
  runContext?: RunContext | Record<string, any>;

  tools?: Record<string, Tool>;

  /** Custom LLM provider factory. Overrides the default provider when set. */
  provider?: LLMProviderFactory;
  /** Model name passed to the provider. Overrides DEFAULT_MODEL when set. */
  model?: string;
  /** Custom system prompt. See SystemPromptOption for the three supported forms. */
  systemPrompt?: SystemPromptOption;

  /** Engine hook arrays - managed by Engine, not by callers directly. */
  hooks?: LoopHooks;
}

/** Wraps tools so each execute() passes through beforeToolCall / afterToolCall hooks. */
function wrapToolsWithHooks(
  tools: Record<string, Tool>,
  beforeHooks: Array<EngineHookMap['beforeToolCall']>,
  afterHooks: Array<EngineHookMap['afterToolCall']>,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    wrapped[name] = {
      ...t,
      execute: async (input: any, ctx: any) => {
        // Run all beforeToolCall hooks sequentially
        let finalInput = input;
        for (const hook of beforeHooks) {
          const result = await hook({ name, input: finalInput });
          if (result && 'input' in result) {
            finalInput = result.input;
          }
        }

        const output = await t.execute(finalInput, ctx);

        // Run all afterToolCall hooks sequentially
        let finalOutput = output;
        for (const hook of afterHooks) {
          const result = await hook({ name, input: finalInput, output: finalOutput });
          if (result && 'output' in result) {
            finalOutput = result.output;
          }
        }

        return finalOutput;
      },
    };
  }
  return wrapped;
}


function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function estimateMessageTokens(messages: ModelMessage[]): number {
  let totalChars = 0;
  for (const message of messages) {
    totalChars += message.role.length;
    if (typeof message.content === 'string') {
      totalChars += message.content.length;
    } else {
      totalChars += safeStringify(message.content).length;
    }
  }
  return Math.ceil(totalChars / 4);
}

async function emitCompactionEvent(
  context: Context,
  options: LoopOptions | undefined,
  loopHooks: LoopHooks,
  params: {
    currentMessages: ModelMessage[];
    newMessages: ModelMessage[];
    trigger: CompactionEvent['trigger'];
    attempt: number;
    reason?: string;
    stats?: CompactStats;
  },
): Promise<void> {
  const event: CompactionEvent = {
    attempt: params.attempt,
    trigger: params.trigger,
    reason: params.reason,
    forced: params.stats?.forced ?? params.trigger === 'length-retry',
    beforeMessageCount: params.stats?.beforeMessageCount ?? params.currentMessages.length,
    afterMessageCount: params.stats?.afterMessageCount ?? params.newMessages.length,
    beforeEstimatedTokens: params.stats?.beforeEstimatedTokens ?? estimateMessageTokens(params.currentMessages),
    afterEstimatedTokens: params.stats?.afterEstimatedTokens ?? estimateMessageTokens(params.newMessages),
    strategy: params.stats?.strategy ?? 'fallback',
  };

  if (options?.onCompacted) {
    options.onCompacted(params.newMessages, event);
  }

  const compactionHooks = loopHooks.onCompacted ?? [];
  if (compactionHooks.length === 0) {
    return;
  }

  const compactionEvent: OnCompactedEvent = event;
  const hookInput: Parameters<EngineHookMap['onCompacted']>[0] = {
    context,
    event: compactionEvent,
    previousMessages: [...params.currentMessages],
    newMessages: [...params.newMessages],
  };

  for (const hook of compactionHooks) {
    try {
      await hook(hookInput);
    } catch {
      // Keep compaction as best-effort; plugin failures must not block the main loop.
    }
  }
}

export async function loop(context: Context, options?: LoopOptions): Promise<string> {
  let errorCount = 0;
  let totalSteps = 0;
  let compactionAttempts = 0;

  const loopHooks = options?.hooks ?? {};

  while (true) {
    try {
      if (options?.abortSignal?.aborted) {
        return 'Request aborted.';
      }

      if (compactionAttempts < MAX_COMPACTION_ATTEMPTS) {
        const { didCompact, reason, newMessages, stats } = await maybeCompactContext(context, {
          provider: options?.provider,
          model: options?.model,
        });
        if (didCompact) {
          const nextAttempt = compactionAttempts + 1;
          compactionAttempts = nextAttempt;

          if (newMessages) {
            await emitCompactionEvent(context, options, loopHooks, {
              currentMessages: context.messages,
              newMessages,
              trigger: 'pre-loop',
              attempt: nextAttempt,
              reason,
              stats,
            });
          }
          continue;
        }
      }

      if (options?.abortSignal?.aborted) {
        return 'Request aborted.';
      }

      let tools = options?.tools || {};
      let systemPrompt = options?.systemPrompt;

      // --- beforeLLMCall hooks ---
      if (loopHooks.beforeLLMCall?.length) {
        for (const hook of loopHooks.beforeLLMCall) {
          const result = await hook({ context, systemPrompt, tools });
          if (result) {
            if ('systemPrompt' in result && result.systemPrompt !== undefined) {
              systemPrompt = result.systemPrompt;
            }
            if ('tools' in result && result.tools !== undefined) {
              tools = result.tools;
            }
          }
        }
      }

      // Wrap tools with beforeToolCall / afterToolCall hooks
      const beforeToolHooks = loopHooks.beforeToolCall ?? [];
      const afterToolHooks = loopHooks.afterToolCall ?? [];
      if (beforeToolHooks.length || afterToolHooks.length) {
        tools = wrapToolsWithHooks(tools, beforeToolHooks, afterToolHooks);
      }

      // Prepare tool execution context
      const toolExecutionContext = {
        onClarificationRequest: options?.onClarificationRequest,
        abortSignal: options?.abortSignal,
        runContext: options?.runContext,
      };

      if (options?.abortSignal?.aborted) {
        return 'Request aborted.';
      }

      const result = streamTextAI(context.messages, tools, {
        abortSignal: options?.abortSignal,
        toolExecutionContext,
        provider: options?.provider,
        model: options?.model,
        systemPrompt,
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
          const messages = [...step.response.messages];
          options?.onResponse?.(messages);
        }
      }

      // --- afterLLMCall hooks ---
      if (loopHooks.afterLLMCall?.length) {
        for (const hook of loopHooks.afterLLMCall) {
          await hook({ context, finishReason, text });
        }
      }

      if (options?.abortSignal?.aborted) {
        return 'Request aborted.';
      }

      if (finishReason === 'stop') {
        if (!text) {
          continue;
        }
        return text || 'Task completed.';
      }

      if (finishReason === 'length') {
        if (compactionAttempts < MAX_COMPACTION_ATTEMPTS) {
          const { didCompact, reason, newMessages, stats } = await maybeCompactContext(context, {
            force: true,
            provider: options?.provider,
            model: options?.model,
          });
          if (didCompact) {
            const nextAttempt = compactionAttempts + 1;
            compactionAttempts = nextAttempt;
            if (newMessages) {
              await emitCompactionEvent(context, options, loopHooks, {
                currentMessages: context.messages,
                newMessages,
                trigger: 'length-retry',
                attempt: nextAttempt,
                reason,
                stats,
              });
            }
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

      if (!text) {
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
        await sleep(delay, options?.abortSignal);
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

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) {
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      reject(abortError);
      return;
    }

    let timeoutId: ReturnType<typeof setTimeout>;

    const onAbort = () => {
      clearTimeout(timeoutId);
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      const abortError = new Error('Aborted');
      abortError.name = 'AbortError';
      reject(abortError);
    };

    timeoutId = setTimeout(() => {
      if (abortSignal) {
        abortSignal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, ms);

    if (abortSignal) {
      abortSignal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
