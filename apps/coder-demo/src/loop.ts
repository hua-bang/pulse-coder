import type { AssistantModelMessage, ToolModelMessage } from "ai";
import generateTextAI from "./ai";
import { MAX_ERROR_COUNT, MAX_TURNS } from "./config";
import type { Context, LoopOptions, LoopResult, TurnInfo, ToolCallInfo } from "./typings";

/**
 * Execute tool calls sequentially, firing lifecycle hooks around each one.
 */
async function executeToolCalls(
  toolResults: Array<{ toolCallId: string; toolName: string; output: any }>,
  hooks: LoopOptions['hooks'],
): Promise<ToolCallInfo[]> {
  const infos: ToolCallInfo[] = [];

  for (const tr of toolResults) {
    const start = Date.now();
    hooks?.onToolCallStart?.({ toolCallId: tr.toolCallId, toolName: tr.toolName, input: undefined });

    const info: ToolCallInfo = {
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      input: undefined,
      output: tr.output,
      durationMs: Date.now() - start,
    };

    infos.push(info);
    hooks?.onToolCallEnd?.(info);
  }

  return infos;
}

/**
 * Core agent loop.
 *
 * Iterates: call the LLM → if it returns tool calls, record them, feed results back
 * → if it returns only text (no tool calls), the task is finished.
 *
 * Removed the old `checkLoopFinish` which made an extra LLM call every turn.
 * The new logic: no tool calls + has text = done. This matches the standard
 * ReAct pattern — the model stops calling tools when it's ready to answer.
 */
async function loop(context: Context, options?: LoopOptions): Promise<LoopResult> {
  const { messages, abortSignal } = context;
  const maxTurns = options?.maxTurns ?? MAX_TURNS;
  const maxErrors = options?.maxErrors ?? MAX_ERROR_COUNT;
  const hooks = options?.hooks;

  const turns: TurnInfo[] = [];
  let consecutiveErrors = 0;
  const loopStart = Date.now();

  for (let turnIndex = 1; turnIndex <= maxTurns; turnIndex++) {
    // Abort check
    if (abortSignal?.aborted) {
      return {
        text: 'Loop aborted.',
        turns,
        finishReason: 'aborted',
        totalDurationMs: Date.now() - loopStart,
      };
    }

    const turnStart = Date.now();
    hooks?.onTurnStart?.({ index: turnIndex });

    try {
      const result = await generateTextAI(messages);

      // Successful LLM call — reset consecutive error counter
      consecutiveErrors = 0;

      const hasToolCalls = !!(result.toolCalls && result.toolCalls.length > 0);
      const hasText = !!result.text;

      if (hasText) {
        hooks?.onText?.(result.text!);
      }

      // ---- No tool calls → the agent is done ----
      if (!hasToolCalls) {
        const text = result.text || '';
        messages.push({ role: 'assistant', content: text });

        const turn: TurnInfo = {
          index: turnIndex,
          toolCalls: [],
          hasText,
          durationMs: Date.now() - turnStart,
        };
        turns.push(turn);
        hooks?.onTurnEnd?.(turn);

        return {
          text,
          turns,
          finishReason: 'complete',
          totalDurationMs: Date.now() - loopStart,
        };
      }

      // ---- Has tool calls → record assistant message + execute tools ----
      const assistantContent: AssistantModelMessage['content'] = [];

      // Preserve text alongside tool calls (some models emit both)
      if (hasText) {
        assistantContent.push({ type: 'text', text: result.text! });
      }

      for (const tc of result.toolCalls!) {
        assistantContent.push({
          type: 'tool-call',
          toolCallId: tc.toolCallId,
          toolName: tc.toolName,
          input: tc.input,
        });
      }

      messages.push({ role: 'assistant', content: assistantContent });

      // Collect tool execution info via hooks
      const toolCallInfos = result.toolResults?.length
        ? await executeToolCalls(result.toolResults as any, hooks)
        : [];

      // Push tool results back into messages for the next turn
      if (result.toolResults && result.toolResults.length > 0) {
        const toolContent: ToolModelMessage['content'] = result.toolResults.map(
          ({ toolCallId, output, toolName }: any) => ({
            toolCallId,
            type: 'tool-result' as const,
            toolName,
            output: { type: 'json' as const, value: output },
          }),
        );
        messages.push({ role: 'tool', content: toolContent });
      }

      const turn: TurnInfo = {
        index: turnIndex,
        toolCalls: toolCallInfos,
        hasText,
        durationMs: Date.now() - turnStart,
      };
      turns.push(turn);
      hooks?.onTurnEnd?.(turn);

    } catch (error: any) {
      consecutiveErrors++;
      const err = error instanceof Error ? error : new Error(String(error));
      hooks?.onError?.(err, { index: turnIndex });

      messages.push({
        role: 'assistant',
        content: `Error during processing: ${err.message}`,
      });

      const turn: TurnInfo = {
        index: turnIndex,
        toolCalls: [],
        hasText: false,
        durationMs: Date.now() - turnStart,
      };
      turns.push(turn);
      hooks?.onTurnEnd?.(turn);

      if (consecutiveErrors >= maxErrors) {
        return {
          text: `Stopped after ${consecutiveErrors} consecutive errors. Last: ${err.message}`,
          turns,
          finishReason: 'max_errors',
          totalDurationMs: Date.now() - loopStart,
        };
      }
    }
  }

  // Reached max turns — surface whatever the last assistant text was
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
  const fallbackText = typeof lastAssistant?.content === 'string' ? lastAssistant.content : '';

  return {
    text: fallbackText || 'Reached maximum number of turns.',
    turns,
    finishReason: 'max_turns',
    totalDurationMs: Date.now() - loopStart,
  };
}

export default loop;
