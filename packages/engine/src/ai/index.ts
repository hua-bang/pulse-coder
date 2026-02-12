import { generateText, streamText, tool, type ModelMessage, type StepResult, type Tool } from 'ai';
import { CoderAI, DEFAULT_MODEL, COMPACT_SUMMARY_MAX_TOKENS, OPENAI_REASONING_EFFORT } from '../config';
import z from 'zod';
import { generateSystemPrompt } from '../prompt';
import type { Tool as CoderTool, ToolExecutionContext } from '../shared/types';


const providerOptions = OPENAI_REASONING_EFFORT
  ? { openai: { reasoningEffort: OPENAI_REASONING_EFFORT } }
  : undefined;

export const generateTextAI = (messages: ModelMessage[], tools: Record<string, Tool>) => {
  const finalMessages = [
    {
      role: 'system',
      content: generateSystemPrompt(),
    },
    ...messages,
  ] as ModelMessage[];

  return generateText({
    model: CoderAI(DEFAULT_MODEL),
    messages: finalMessages,
    tools,
    providerOptions,
  }) as unknown as ReturnType<typeof generateText> & { steps: StepResult<any>[]; finishReason: string };
}

export interface StreamOptions {
  abortSignal?: AbortSignal;
  onStepFinish?: (event: StepResult<any>) => void;
  onChunk?: (event: { chunk: any }) => void;
  toolExecutionContext?: ToolExecutionContext;
}

/**
 * Wraps tools to inject ToolExecutionContext before execution
 */
export const wrapToolsWithContext = (
  tools: Record<string, CoderTool>,
  context?: ToolExecutionContext
): Record<string, Tool> => {
  const wrappedTools: Record<string, Tool> = {};

  for (const [name, tool] of Object.entries(tools)) {
    wrappedTools[name] = {
      ...tool,
      execute: async (input: any) => {
        // Call the original execute with context
        return await tool.execute(input, context);
      }
    } as Tool;
  }

  return wrappedTools;
};

export const streamTextAI = (messages: ModelMessage[], tools: Record<string, CoderTool>, options?: StreamOptions) => {

  const finalMessages = [
    {
      role: 'system',
      content: generateSystemPrompt(),
    },
    ...messages,
  ] as ModelMessage[];

  // Wrap tools with execution context if provided
  const wrappedTools = options?.toolExecutionContext
    ? wrapToolsWithContext(tools, options.toolExecutionContext)
    : tools;

  return streamText({
    model: CoderAI(DEFAULT_MODEL),
    messages: finalMessages,
    tools: wrappedTools as Record<string, Tool>,
    providerOptions,
    abortSignal: options?.abortSignal,
    onStepFinish: options?.onStepFinish,
    onChunk: options?.onChunk,
  }) as unknown as ReturnType<typeof streamText> & { steps: StepResult<any>[]; finishReason: string };
}

export const summarizeMessages = async (
  messages: ModelMessage[],
  options?: { maxOutputTokens?: number }
): Promise<string> => {
  const SUMMARY_SYSTEM_PROMPT =
    '你是负责压缩对话上下文的助手。请基于给定历史消息，提炼关键事实与决策，避免臆测或扩展。';

  const SUMMARY_USER_PROMPT = [
    '请将以上对话压缩为以下格式，使用中文：',
    '[COMPACTED_CONTEXT]',
    '- 目标: ...',
    '- 进展: ...',
    '- 关键结果: ...',
    '- 文件与变更: ...',
    '- 关键片段: "..." / `...` / "..."',
    '- 待确认: ...',
    '',
    '要求：内容简洁准确，不要编造。',
  ].join('\n');

  const result = await generateText({
    model: CoderAI(DEFAULT_MODEL),
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      ...messages,
      { role: 'user', content: SUMMARY_USER_PROMPT },
    ],
    maxOutputTokens: options?.maxOutputTokens ?? COMPACT_SUMMARY_MAX_TOKENS,
    providerOptions,
  });

  return result.text ?? '';
}