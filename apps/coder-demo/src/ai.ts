import { generateText, stepCountIs, streamText, tool, type ModelMessage, type StepResult, type Tool } from 'ai';
import {
  CoderAI,
  DEFAULT_MODEL,
  MAX_STEPS,
  COMPACT_SUMMARY_MAX_TOKENS,
  OPENAI_REASONING_EFFORT,
} from './config';
import { BuiltinTools } from './tools';
import { generateSystemPrompt } from './prompt';
import z from 'zod';

const BuiltinToolsMap = BuiltinTools.reduce((acc, toolInstance) => {
  acc[toolInstance.name] = tool(toolInstance as Tool);
  return acc;
}, {} as Record<string, Tool>);

const providerOptions = OPENAI_REASONING_EFFORT
  ? { openai: { reasoningEffort: OPENAI_REASONING_EFFORT } }
  : undefined;

export const generateTextAI = (messages: ModelMessage[]): ReturnType<typeof generateText> => {
  const finalMessages = [
    {
      role: 'system',
      content: generateSystemPrompt(),
    },
    ...messages,
  ] as ModelMessage[];

  return generateText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: finalMessages,
    tools: BuiltinToolsMap,
    providerOptions,
  }) as unknown as ReturnType<typeof generateText>;
}

export interface StreamOptions {
  abortSignal?: AbortSignal;
  onStepFinish?: (event: StepResult<any>) => void;
  onChunk?: (event: { chunk: any }) => void;
}

export const streamTextAI = (messages: ModelMessage[], options?: StreamOptions): ReturnType<typeof streamText> => {
  const finalMessages = [
    {
      role: 'system',
      content: generateSystemPrompt(),
    },
    ...messages,
  ] as ModelMessage[];

  return streamText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: finalMessages,
    tools: BuiltinToolsMap,
    providerOptions,
    abortSignal: options?.abortSignal,
    onStepFinish: options?.onStepFinish,
    onChunk: options?.onChunk,
  }) as unknown as ReturnType<typeof streamText>;
}

export const generateObject = async <T extends z.ZodSchema>(messages: ModelMessage[], schema: T, description: string) => {
  // 使用 tool calling 的方式来实现结构化输出
  const result = await generateText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: messages,
    tools: {
      respond: tool({
        description,
        inputSchema: schema,
        execute: async (input: any) => input,
      })
    },
    toolChoice: {
      type: 'tool',
      toolName: 'respond',
    },
    providerOptions,
  });

  // 返回 tool call 的结果
  if (result.toolCalls && result.toolCalls.length > 0) {
    return result!.toolCalls[0]!.input as z.infer<T>;
  }

  console.log(result);

  throw new Error('No structured output generated');
}

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
  '要求：',
  '1) 内容简洁准确，不要编造。',
  '2) 关键片段保留 3–6 条短片段（命令/报错/关键句）。',
  `3) 总结长度控制在约 ${COMPACT_SUMMARY_MAX_TOKENS} tokens 以内。`,
].join('\n');

export const summarizeMessages = async (
  messages: ModelMessage[],
  options?: { maxOutputTokens?: number }
): Promise<string> => {
  const result = await generateText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: [
      { role: 'system', content: SUMMARY_SYSTEM_PROMPT },
      ...messages,
      { role: 'user', content: SUMMARY_USER_PROMPT },
    ],
    maxOutputTokens: options?.maxOutputTokens ?? COMPACT_SUMMARY_MAX_TOKENS,
    providerOptions,
  });

  return result.text ?? '';
};

export default generateTextAI;
