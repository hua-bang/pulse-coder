import { generateText, streamText, tool, type ModelMessage, type StepResult, type Tool } from 'ai';
import { CoderAI, DEFAULT_MODEL, COMPACT_SUMMARY_MAX_TOKENS, COMPACT_SUMMARY_MODEL, OPENAI_REASONING_EFFORT } from '../config';
import z from 'zod';
import { generateSystemPrompt } from '../prompt';
import type { Tool as CoderTool, ToolExecutionContext, LLMProviderFactory, SystemPromptOption, ModelType } from '../shared/types';


const openaiProviderOptions = { openai: { store: false, reasoningEffort: OPENAI_REASONING_EFFORT } };
const claudeProviderOptions = { anthropic: { cacheControl: { type: 'ephemeral' as const } } };

/**
 * Default per-call output token caps.
 *
 * The Vercel AI SDK does NOT pass `maxOutputTokens` automatically — when omitted,
 * Anthropic provider falls back to its protocol default of 4096, which Claude
 * regularly burns entirely on internal thinking tokens, surfacing as
 * `finishReason='length'` with `textLen=0`. We were misdiagnosing that as a
 * context-window overflow and force-compacting the history (see loop.ts), which
 * never helped because the bottleneck was output tokens, not input.
 *
 * Set explicit, generous caps. Anthropic Claude Sonnet 4.x supports up to
 * 64K output tokens; 16K is enough for reasoning + final answer in practice
 * while keeping latency/cost reasonable.
 */
const DEFAULT_MAX_OUTPUT_TOKENS_CLAUDE = Number(process.env.CLAUDE_MAX_OUTPUT_TOKENS ?? 32768);
const DEFAULT_MAX_OUTPUT_TOKENS_OPENAI = Number(process.env.OPENAI_MAX_OUTPUT_TOKENS ?? 16384);

function resolveMaxOutputTokens(modelType?: ModelType): number {
  return modelType === 'claude' ? DEFAULT_MAX_OUTPUT_TOKENS_CLAUDE : DEFAULT_MAX_OUTPUT_TOKENS_OPENAI;
}

function resolveProviderOptions(modelType?: ModelType) {
  if (modelType === 'claude') {
    return { ...openaiProviderOptions, ...claudeProviderOptions };
  }
  return openaiProviderOptions;
}

const GPT_EXPLORATION_CONSTRAINT = `
## File exploration discipline
- Read only the files that are directly required for the current task. Do not speculatively explore the codebase.
- Never read the same file more than once unless you have a specific reason to re-verify changed content.
- Start acting as soon as you have sufficient context; do not keep exploring for completeness or reassurance.
- Prefer targeted reads (specific file you know you need) over broad directory listings.
`.trim();

/** Resolve a SystemPromptOption into a final string. */
const resolveSystemPrompt = (option: SystemPromptOption | undefined): string => {
  const base = generateSystemPrompt();
  if (!option) return base;
  if (typeof option === 'string') return option;
  if (typeof option === 'function') return option();
  return `${base}\n\n${option.append}`;
};

export const generateTextAI = (
  messages: ModelMessage[],
  tools: Record<string, Tool>,
  options?: { provider?: LLMProviderFactory; model?: string; systemPrompt?: SystemPromptOption }
) => {
  const provider = options?.provider ?? CoderAI;
  const model = options?.model ?? DEFAULT_MODEL;

  return generateText({
    model: provider(model),
    system: resolveSystemPrompt(options?.systemPrompt),
    messages,
    tools,
    providerOptions: openaiProviderOptions,
  }) as unknown as ReturnType<typeof generateText> & { steps: StepResult<any>[]; finishReason: string };
}

export interface StreamOptions {
  abortSignal?: AbortSignal;
  onStepFinish?: (event: StepResult<any>) => void;
  onChunk?: (event: { chunk: any }) => void;
  toolExecutionContext?: ToolExecutionContext;
  /** Custom LLM provider. Falls back to the default CoderAI provider when not set. */
  provider?: LLMProviderFactory;
  /** Model name to pass to the provider. Falls back to DEFAULT_MODEL when not set. */
  model?: string;
  /** Provider type hint. When set to 'claude', system messages in history are consolidated. */
  modelType?: ModelType;
  /** Custom system prompt. See SystemPromptOption for the three supported forms. */
  systemPrompt?: SystemPromptOption;
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
  const provider = options?.provider ?? CoderAI;
  const model = options?.model ?? DEFAULT_MODEL;

  // Wrap tools with execution context if provided
  const wrappedTools = options?.toolExecutionContext
    ? wrapToolsWithContext(tools, options.toolExecutionContext)
    : tools;

  // Extract system-role messages from history and merge into system prompt.
  // Anthropic does not allow multiple system messages interleaved with user/assistant turns.
  const extraSystemParts: string[] = [];
  const filteredMessages = options?.modelType === 'claude'
    ? messages.filter((m) => {
        if (m.role !== 'system') return true;
        const raw = m.content as unknown;
        const text = typeof raw === 'string'
          ? raw
          : Array.isArray(raw)
            ? (raw as any[]).filter((p) => p.type === 'text').map((p) => p.text).join('\n')
            : '';
        if (text) extraSystemParts.push(text);
        return false;
      })
    : messages;

  const baseSystemPrompt = resolveSystemPrompt(options?.systemPrompt);
  const gptExtra = options?.modelType !== 'claude' ? `\n\n${GPT_EXPLORATION_CONSTRAINT}` : '';
  const finalSystemPrompt = extraSystemParts.length > 0
    ? `${baseSystemPrompt}${gptExtra}\n\n${extraSystemParts.join('\n\n')}`
    : `${baseSystemPrompt}${gptExtra}`;

  return streamText({
    model: provider(model),
    system: finalSystemPrompt,
    messages: filteredMessages,
    tools: wrappedTools as Record<string, Tool>,
    providerOptions: resolveProviderOptions(options?.modelType),
    maxOutputTokens: resolveMaxOutputTokens(options?.modelType),
    abortSignal: options?.abortSignal,
    onStepFinish: options?.onStepFinish,
    onChunk: options?.onChunk,
  }) as unknown as ReturnType<typeof streamText> & { steps: StepResult<any>[]; finishReason: string };
}

export const summarizeMessages = async (
  messages: ModelMessage[],
  options?: { maxOutputTokens?: number; provider?: LLMProviderFactory; model?: string }
): Promise<string> => {
  const provider = options?.provider ?? CoderAI;
  const model = options?.model ?? COMPACT_SUMMARY_MODEL ?? DEFAULT_MODEL;
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
    model: provider(model),
    system: SUMMARY_SYSTEM_PROMPT,
    messages: [
      ...messages,
      { role: 'user', content: SUMMARY_USER_PROMPT },
    ],
    maxOutputTokens: options?.maxOutputTokens ?? COMPACT_SUMMARY_MAX_TOKENS,
    providerOptions: openaiProviderOptions,
  });

  return result.text ?? '';
}