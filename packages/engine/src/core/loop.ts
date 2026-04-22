import { ToolSet, type StepResult, type ModelMessage } from "ai";
import type { Context, ClarificationRequest, Tool, LLMProviderFactory, SystemPromptOption, ModelType } from "../shared/types";
import type { EngineHookMap, OnCompactedEvent } from "../plugin/EnginePlugin.js";
import { streamTextAI } from "../ai";
import { maybeCompactContext, type CompactStats } from "../context";
import {
  MAX_COMPACTION_ATTEMPTS,
  MAX_ERROR_COUNT,
  MAX_STEPS,
  buildProvider,
} from "../config/index.js";

/**
 * Coarse per-family input-token budgets. Used only to disambiguate
 * `finishReason='length'` between (a) prompt overflow and (b) output-cap
 * exhaustion. Doesn't need to be exact — a conservative lower bound keeps
 * us safe.
 *
 * Override per deployment via env: MODEL_CONTEXT_BUDGET (single global cap).
 */
const MODEL_CONTEXT_BUDGET_OVERRIDE = Number(process.env.MODEL_CONTEXT_BUDGET ?? 0) || undefined;

function resolveModelContextBudget(model?: string, modelType?: ModelType): number {
  if (MODEL_CONTEXT_BUDGET_OVERRIDE && MODEL_CONTEXT_BUDGET_OVERRIDE > 0) {
    return MODEL_CONTEXT_BUDGET_OVERRIDE;
  }
  const name = (model ?? '').toLowerCase();
  if (modelType === 'claude' || name.includes('claude')) {
    // Claude 3.5/4.x sonnet & opus all support 200K. Use 180K as safe budget.
    return 180_000;
  }
  if (name.includes('gpt-5') || name.includes('gpt-4.1') || name.includes('o1') || name.includes('o3')) {
    return 180_000;
  }
  if (name.includes('gpt-4o')) {
    return 110_000;
  }
  if (name.includes('gemini')) {
    return 900_000;
  }
  // Conservative default
  return 110_000;
}

/**
 * Hook arrays passed into the loop by Engine.
 * Each array may contain handlers from multiple plugins + EngineOptions.
 */
export interface LoopHooks {
  beforeLLMCall?: Array<EngineHookMap['beforeLLMCall']>;
  afterLLMCall?: Array<EngineHookMap['afterLLMCall']>;
  beforeToolCall?: Array<EngineHookMap['beforeToolCall']>;
  afterToolCall?: Array<EngineHookMap['afterToolCall']>;
  onToolCall?: Array<EngineHookMap['onToolCall']>;
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
  runContext?: Record<string, any>;

  tools?: Record<string, Tool>;

  /** Custom LLM provider factory. Overrides the default provider when set. */
  provider?: LLMProviderFactory;
  /**
   * Named provider type. Used to construct a provider from env vars without importing the SDK.
   * Ignored when `provider` is set explicitly.
   * - `'openai'` → OPENAI_API_KEY / OPENAI_API_URL
   * - `'claude'` → ANTHROPIC_API_KEY / ANTHROPIC_API_URL
   */
  modelType?: ModelType;
  /** Model name passed to the provider. Overrides DEFAULT_MODEL when set. */
  model?: string;
  /** Custom system prompt. See SystemPromptOption for the three supported forms. */
  systemPrompt?: SystemPromptOption;

  /** Engine hook arrays - managed by Engine, not by callers directly. */
  hooks?: LoopHooks;

  /** Override the global MAX_STEPS for this loop invocation. */
  maxSteps?: number;
}

/**
 * Wraps read/ls tools to warn the model when it accesses the same path more than once.
 * The seenPaths map persists for the lifetime of a single loop() call.
 */
function wrapToolsWithReadDedup(
  tools: Record<string, Tool>,
  seenPaths: Map<string, number>,
): Record<string, Tool> {
  const READ_TOOL_NAMES = new Set(['read', 'ls']);
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!READ_TOOL_NAMES.has(name)) {
      wrapped[name] = t;
      continue;
    }
    wrapped[name] = {
      ...t,
      execute: async (input: any, ctx: any) => {
        const pathKey = input?.filePath ?? input?.path ?? name;
        const count = seenPaths.get(pathKey) ?? 0;
        seenPaths.set(pathKey, count + 1);
        const output = await t.execute(input, ctx);
        if (count > 0) {
          const note = `[You have already accessed "${pathKey}" ${count} time(s) in this session. Avoid redundant reads unless strictly necessary.]`;
          if (typeof output === 'string') return `${output}\n${note}`;
          if (output && typeof output === 'object') return { ...output, _note: note };
        }
        return output;
      },
    };
  }
  return wrapped;
}

/** Wraps tools so each execute() passes through beforeToolCall / afterToolCall hooks. */
function wrapToolsWithHooks(
  tools: Record<string, Tool>,
  beforeHooks: Array<EngineHookMap['beforeToolCall']>,
  afterHooks: Array<EngineHookMap['afterToolCall']>,
  context: Context,
): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    wrapped[name] = {
      ...t,
      execute: async (input: any, ctx: any) => {
        // Run all beforeToolCall hooks sequentially
        let finalInput = input;
        for (const hook of beforeHooks) {
          const result = await hook({ context, name, input: finalInput });
          if (result && 'input' in result) {
            finalInput = result.input;
          }
        }

        const output = await t.execute(finalInput, ctx);

        // Run all afterToolCall hooks sequentially
        let finalOutput = output;
        for (const hook of afterHooks) {
          const result = await hook({ context, name, input: finalInput, output: finalOutput });
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
  const seenPaths = new Map<string, number>();

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
          const result = await hook({ context, systemPrompt, tools, runContext: options?.runContext, model: options?.model });
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

      // Inject read/ls deduplication warnings
      tools = wrapToolsWithReadDedup(tools, seenPaths);

      // Wrap tools with beforeToolCall / afterToolCall hooks
      const beforeToolHooks = loopHooks.beforeToolCall ?? [];
      const afterToolHooks = loopHooks.afterToolCall ?? [];
      if (beforeToolHooks.length || afterToolHooks.length) {
        tools = wrapToolsWithHooks(tools, beforeToolHooks, afterToolHooks, context);
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

      let requestStartAt: number | undefined;
      let firstChunkAt: number | undefined;
      let firstTextAt: number | undefined;
      let lastChunkAt: number | undefined;

      requestStartAt = Date.now();
      const result = streamTextAI(context.messages, tools, {
        abortSignal: options?.abortSignal,
        toolExecutionContext,
        provider: options?.provider ?? (options?.modelType ? buildProvider(options.modelType) : undefined),
        model: options?.model,
        modelType: options?.modelType,
        systemPrompt,
        onStepFinish: (step) => {
          options?.onStepFinish?.(step);
        },
        onChunk: ({ chunk }) => {
          const chunkAt = Date.now();
          if (firstChunkAt === undefined) {
            firstChunkAt = chunkAt;
          }
          if (chunk.type === 'text-delta' && firstTextAt === undefined) {
            firstTextAt = chunkAt;
          }
          lastChunkAt = chunkAt;
          if (chunk.type === 'text-delta') {
            options?.onText?.(chunk.text);
          }
          if (chunk.type === 'tool-call') {
            options?.onToolCall?.(chunk);
            const toolCallHooks = loopHooks.onToolCall ?? [];
            if (toolCallHooks.length > 0) {
              for (const hook of toolCallHooks) {
                Promise.resolve(hook({ context, toolCall: chunk })).catch(() => undefined);
              }
            }
          }
          if (chunk.type === 'tool-result') {
            options?.onToolResult?.(chunk);
          }
        },
      });

      const usagePromise = (result as any).usage;
      const [text, steps, finishReason, usage] = await Promise.all([
        result.text,
        result.steps,
        result.finishReason,
        usagePromise ? Promise.resolve(usagePromise) : Promise.resolve(undefined),
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
          await hook({
            context,
            finishReason,
            text,
            usage,
            model: options?.model,
            timings: {
              requestStartAt,
              firstChunkAt,
              firstTextAt,
              lastChunkAt,
            },
          });
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
        // `finishReason === 'length'` is ambiguous:
        //   (a) prompt exceeded the model's context window, or
        //   (b) per-call output cap (`maxOutputTokens`) was exhausted —
        //       common with Claude when reasoning tokens eat the whole 4096
        //       default cap before any text is emitted.
        //
        // Previously we always treated it as (a) and force-compacted, which
        // never helps case (b) and silently shrinks healthy sessions. Now we
        // disambiguate using `usage.inputTokens` against a per-model context
        // budget. Output-cap hits just continue the loop so the model can
        // resume; only true overflow triggers compaction.
        const inputTokens = (usage as any)?.inputTokens ?? (usage as any)?.input_tokens;
        const modelContextBudget = resolveModelContextBudget(options?.model, options?.modelType);
        const looksLikeContextOverflow =
          typeof inputTokens === 'number' && inputTokens >= modelContextBudget * 0.8;

        if (!looksLikeContextOverflow) {
          // Output-cap hit (case b). Don't compact. Loop continues; if the
          // SDK already wrote a partial assistant message into the step
          // history, the next iteration will see it and resume naturally.
          continue;
        }

        // True context overflow (case a): compact up to N times.
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
        // Provider's safety/policy layer rejected the response. Surface a more
        // actionable message so users know it's not an internal bug. Log the
        // event with usage details so operators can correlate by timestamp.
        console.warn('[loop] content-filter finishReason', {
          textLen: text?.length ?? 0,
          textTail: typeof text === 'string' ? text.slice(-200) : undefined,
          inputTokens: (usage as any)?.inputTokens,
          outputTokens: (usage as any)?.outputTokens,
          model: options?.model,
          modelType: options?.modelType,
          msgCount: context.messages.length,
        });
        return text || '⚠️ Upstream content filter blocked this response (provider safety policy). Try rephrasing, splitting the request, or switching model.';
      }

      if (finishReason === 'error') {
        console.warn('[loop] error finishReason', {
          textLen: text?.length ?? 0,
          inputTokens: (usage as any)?.inputTokens,
          outputTokens: (usage as any)?.outputTokens,
          model: options?.model,
          modelType: options?.modelType,
        });
        return text || 'Task failed.';
      }

      if (finishReason === 'tool-calls') {
        if (totalSteps >= (options?.maxSteps ?? MAX_STEPS)) {
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
