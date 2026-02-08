import { type AssistantModelMessage, type StepResult, type ToolModelMessage } from "ai";
import { streamTextAI } from "./ai";
import { MAX_ERROR_COUNT, MAX_STEPS } from "./config";
import type { Context } from "./typings";

export interface LoopOptions {
  onText?: (delta: string) => void;
  onToolCall?: (toolCall: any) => void;
  onToolResult?: (toolResult: any) => void;
  onStepFinish?: (step: StepResult<any>) => void;
  abortSignal?: AbortSignal;
}

const buildAssistantMessage = (step: StepResult<any>): AssistantModelMessage | null => {
  const parts: Array<AssistantModelMessage['content'] extends Array<infer Part> ? Part : never> = [];

  if (step.text) {
    parts.push({ type: 'text', text: step.text });
  }

  if (step.toolCalls?.length) {
    parts.push(
      ...step.toolCalls.map((toolCall) => ({
        type: 'tool-call' as const,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input: toolCall.input,
      }))
    );
  }

  if (parts.length === 0) {
    return null;
  }

  const content = parts.length === 1 && parts[0].type === 'text' ? parts[0].text : parts;

  return {
    role: 'assistant',
    content,
  };
};

const buildToolMessage = (step: StepResult<any>): ToolModelMessage | null => {
  if (!step.toolResults?.length) {
    return null;
  }

  const content: ToolModelMessage['content'] = step.toolResults.map((toolResult) => ({
    type: 'tool-result',
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    output: {
      type: 'json',
      value: toolResult.output as any,
    },
  }));

  return {
    role: 'tool',
    content,
  };
};

async function loop(context: Context, options?: LoopOptions): Promise<string> {
  const { messages } = context;
  let errorCount = 0;
  let totalSteps = 0;

  while (true) {
    try {
      const result = streamTextAI(messages, {
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
        const assistantMessage = buildAssistantMessage(step);
        if (assistantMessage) {
          messages.push(assistantMessage);
        }

        const toolMessage = buildToolMessage(step);
        if (toolMessage) {
          messages.push(toolMessage);
        }
      }

      if (finishReason === 'stop') {
        return text || 'Task completed.';
      }

      if (finishReason === 'length') {
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
