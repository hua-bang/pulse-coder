import dotenv from "dotenv";
import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from "@ai-sdk/anthropic";
import { LanguageModel } from "ai";

dotenv.config();

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

type ProviderType = 'openai' | 'anthropic';

type ProviderConfig = {
  type?: string;
  apiKeyEnv?: string;
  baseUrlEnv?: string;
  baseUrl?: string;
};

type ResolvedProviderConfig = {
  type: ProviderType;
  apiKey: string;
  baseURL: string;
};

const resolveEnvValue = (key?: string): string | undefined => {
  if (!key) {
    return undefined;
  }
  const value = process.env[key];
  return value && value.trim() ? value.trim() : undefined;
};

const normalizeProviderType = (value: unknown): ProviderType | null => {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toLowerCase();
  if (trimmed === 'openai' || trimmed === 'anthropic') {
    return trimmed as ProviderType;
  }
  return null;
};

export const resolveProviderConfig = (config?: ProviderConfig): ResolvedProviderConfig | null => {
  const resolvedType = normalizeProviderType(config?.type);
  if (!resolvedType) {
    return null;
  }

  const apiKey = resolveEnvValue(config?.apiKeyEnv) ?? '';
  const baseURL = resolveEnvValue(config?.baseUrlEnv)
    ?? config?.baseUrl
    ?? (resolvedType === 'anthropic' ? DEFAULT_ANTHROPIC_BASE_URL : DEFAULT_OPENAI_BASE_URL);

  return { type: resolvedType, apiKey, baseURL };
};

export const createProviderFactory = (config?: ProviderConfig): ((model: string) => LanguageModel) | null => {
  const resolved = resolveProviderConfig(config);
  if (!resolved) {
    return null;
  }

  if (resolved.type === 'anthropic') {
    return createAnthropic({
      apiKey: resolved.apiKey,
      baseURL: resolved.baseURL,
    });
  }

  return createOpenAI({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
  }).responses;
};

export const CoderAI = (createProviderFactory(process.env.USE_ANTHROPIC
  ? {
      type: 'anthropic',
      apiKeyEnv: 'ANTHROPIC_API_KEY',
      baseUrlEnv: 'ANTHROPIC_API_URL',
      baseUrl: DEFAULT_ANTHROPIC_BASE_URL,
    }
  : {
      type: 'openai',
      apiKeyEnv: 'OPENAI_API_KEY',
      baseUrlEnv: 'OPENAI_API_URL',
      baseUrl: DEFAULT_OPENAI_BASE_URL,
    }) ?? (process.env.USE_ANTHROPIC
      ? createAnthropic({
          apiKey: process.env.ANTHROPIC_API_KEY || '',
          baseURL: process.env.ANTHROPIC_API_URL || DEFAULT_ANTHROPIC_BASE_URL,
        })
      : createOpenAI({
          apiKey: process.env.OPENAI_API_KEY || '',
          baseURL: process.env.OPENAI_API_URL || DEFAULT_OPENAI_BASE_URL,
        }).responses)) as (model: string) => LanguageModel;

export const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || process.env.OPENAI_MODEL || 'novita/deepseek/deepseek_v3';

export const MAX_TURNS = 100;
export const MAX_ERROR_COUNT = 3;
export const MAX_STEPS = 100;
export const MAX_TOOL_OUTPUT_LENGTH = 30_000;

export const CONTEXT_WINDOW_TOKENS = Number(process.env.CONTEXT_WINDOW_TOKENS ?? 64_000);
export const COMPACT_TRIGGER = Number(process.env.COMPACT_TRIGGER ?? Math.floor(CONTEXT_WINDOW_TOKENS * 0.75));
export const COMPACT_TARGET = Number(process.env.COMPACT_TARGET ?? Math.floor(CONTEXT_WINDOW_TOKENS * 0.5));
export const KEEP_LAST_TURNS = Number(process.env.KEEP_LAST_TURNS ?? 4);
export const COMPACT_SUMMARY_MODEL = (process.env.COMPACT_SUMMARY_MODEL ?? '').trim();
export const COMPACT_SUMMARY_MAX_TOKENS = Number(process.env.COMPACT_SUMMARY_MAX_TOKENS ?? 1200);
export const MAX_COMPACTION_ATTEMPTS = Number(process.env.MAX_COMPACTION_ATTEMPTS ?? 2);
export const OPENAI_REASONING_EFFORT = process.env.OPENAI_REASONING_EFFORT;

// Clarification settings
export const CLARIFICATION_TIMEOUT = Number(process.env.CLARIFICATION_TIMEOUT ?? 300_000); // 5 minutes
export const CLARIFICATION_ENABLED = process.env.CLARIFICATION_ENABLED !== 'false';

export type { ProviderConfig, ProviderType };
