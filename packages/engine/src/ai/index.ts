import { generateText, streamText, type ModelMessage, type StepResult, type Tool } from 'ai';
import { CoderAI, DEFAULT_MODEL, COMPACT_SUMMARY_MAX_TOKENS, OPENAI_REASONING_EFFORT } from '../config';
import { generateSystemPrompt } from '../prompt';

const providerOptions = OPENAI_REASONING_EFFORT
  ? { openai: { reasoningEffort: OPENAI_REASONING_EFFORT } }
  : undefined;

export const generateTextAI = (messages: ModelMessage[], tools: Record<string, Tool>, options?: { systemPrompt?: string }) => {
  const finalMessages = [
    {
      role: 'system',
      content: options?.systemPrompt ?? generateSystemPrompt(),
    },
    ...messages,
  ] as ModelMessage[];

  return generateText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: finalMessages,
    tools,
    providerOptions,
  }) as unknown as ReturnType<typeof generateText> & { steps: StepResult<any>[]; finishReason: string };
}

export interface StreamOptions {
  abortSignal?: AbortSignal;
  onStepFinish?: (event: StepResult<any>) => void;
  onChunk?: (event: { chunk: any }) => void;
  systemPrompt?: string;
}

export const streamTextAI = (messages: ModelMessage[], tools: Record<string, Tool>, options?: StreamOptions) => {

  const finalMessages = [
    {
      role: 'system',
      content: options?.systemPrompt ?? generateSystemPrompt(),
    },
    ...messages,
  ] as ModelMessage[];

  return streamText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: finalMessages,
    tools,
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
}
