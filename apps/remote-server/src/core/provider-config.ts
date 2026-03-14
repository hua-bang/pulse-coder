import { createOpenAI } from '@ai-sdk/openai';
import { createAnthropic } from '@ai-sdk/anthropic';
import type { LLMProviderFactory } from 'pulse-coder-engine';
import { getProviderConfig, resolveProviderForRun } from './model-config.js';

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

type ResolvedProvider = {
  key: string;
  provider: LLMProviderFactory;
};

const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_ANTHROPIC_BASE_URL = 'https://api.anthropic.com/v1';

const normalizeProviderKey = (value: string): string => value.trim().toLowerCase();

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

const resolveProviderConfig = (config?: ProviderConfig): ResolvedProviderConfig | null => {
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

const createProviderFactory = (config?: ProviderConfig): LLMProviderFactory | null => {
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

export async function resolveProviderFactoryForRun(platformKey: string): Promise<ResolvedProvider | null> {
  const providerKey = (await resolveProviderForRun(platformKey))
    ?? (process.env.USE_ANTHROPIC ? 'anthropic' : 'openai');
  if (!providerKey) {
    return null;
  }

  const normalizedKey = normalizeProviderKey(providerKey);
  const config = await getProviderConfig(normalizedKey);
  if (!config) {
    return null;
  }

  const providerConfig: ProviderConfig = {
    type: config.type ?? normalizedKey,
    apiKeyEnv: config.apiKeyEnv,
    baseUrlEnv: config.baseUrlEnv,
    baseUrl: config.baseUrl,
  };

  const provider = createProviderFactory(providerConfig);
  if (!provider) {
    return null;
  }

  return { key: normalizedKey, provider };
}
