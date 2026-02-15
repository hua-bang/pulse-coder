import { ToolSet, type StepResult, type ModelMessage } from "ai";
import type { Context, ClarificationRequest, Tool, LLMProviderFactory, SystemPromptOption, ToolHooks } from "../shared/types";
import { streamTextAI } from "../ai";
import { maybeCompactContext } from "../context";
import {
  MAX_COMPACTION_ATTEMPTS,
  MAX_ERROR_COUNT,
  MAX_STEPS
} from "../config/index.js";

export interface LoopOptions {
  onText?: (delta: string) => void;
  onToolCall?: (toolCall: any) => void;
  onToolResult?: (toolResult: any) => void;
  onStepFinish?: (step: StepResult<any>) => void;
  onClarificationRequest?: (request: ClarificationRequest) => Promise<string>;
  onCompacted?: (newMessages: ModelMessage[]) => void;
  onResponse?: (messages: StepResult<ToolSet>['response']['messages']) => void;
  abortSignal?: AbortSignal;

  tools?: Record<string, Tool>; // 允许传入工具覆盖默认工具

  /** Custom LLM provider factory. Overrides the default provider when set. */
  provider?: LLMProviderFactory;
  /** Model name passed to the provider. Overrides DEFAULT_MODEL when set. */
  model?: string;
  /** Custom system prompt. See SystemPromptOption for the three supported forms. */
  systemPrompt?: SystemPromptOption;
  /** Hooks fired around every tool execution (before/after). */
  hooks?: ToolHooks;
}

/** Wraps tools with ToolHooks so each call passes through before/after handlers. */
function applyToolHooks(tools: Record<string, Tool>, hooks: ToolHooks): Record<string, Tool> {
  const wrapped: Record<string, Tool> = {};
  for (const [name, t] of Object.entries(tools)) {
    wrapped[name] = {
      ...t,
      execute: async (input: any, ctx: any) => {
        const finalInput = hooks.onBeforeToolCall
          ? (await hooks.onBeforeToolCall(name, input)) ?? input
          : input;
        const output = await t.execute(finalInput, ctx);
        return hooks.onAfterToolCall
          ? (await hooks.onAfterToolCall(name, finalInput, output)) ?? output
          : output;
      },
    };
  }
  return wrapped;
}

export async function loop(context: Context, options?: LoopOptions): Promise<string> {
  let errorCount = 0;
  let totalSteps = 0;
  let compactionAttempts = 0;

  while (true) {
    try {
      if (compactionAttempts < MAX_COMPACTION_ATTEMPTS) {
        const { didCompact, newMessages } = await maybeCompactContext(context, {
          provider: options?.provider,
          model: options?.model,
        });
        if (didCompact) {
          compactionAttempts++;

          if (newMessages) {
            options?.onCompacted?.(newMessages)
          }
          continue;
        }
      }

      let tools = options?.tools || {}; // 允许传入工具覆盖默认工具

      // Apply tool hooks if provided
      if (options?.hooks) {
        tools = applyToolHooks(tools, options.hooks);
      }

      // Prepare tool execution context
      const toolExecutionContext = {
        onClarificationRequest: options?.onClarificationRequest,
        abortSignal: options?.abortSignal
      };

      const result = streamTextAI(context.messages, tools, {
        abortSignal: options?.abortSignal,
        toolExecutionContext,
        provider: options?.provider,
        model: options?.model,
        systemPrompt: options?.systemPrompt,
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

      if (finishReason === 'stop') {
        return text || 'Task completed.';
      }

      if (finishReason === 'length') {
        if (compactionAttempts < MAX_COMPACTION_ATTEMPTS) {
          const { didCompact, newMessages } = await maybeCompactContext(context, {
          force: true,
          provider: options?.provider,
          model: options?.model,
        });
          if (didCompact) {
            compactionAttempts++;
            if (newMessages) {
              options?.onCompacted?.(newMessages)
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