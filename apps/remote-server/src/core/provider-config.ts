import type { ProviderConfig } from 'pulse-coder-engine';
import type { LLMProviderFactory } from 'pulse-coder-engine';
import { createProviderFactory } from 'pulse-coder-engine';
import { getProviderConfig, resolveProviderForRun } from './model-config.js';

type ResolvedProvider = {
  key: string;
  provider: LLMProviderFactory;
};

const normalizeProviderKey = (value: string): string => value.trim().toLowerCase();

export async function resolveProviderFactoryForRun(platformKey: string): Promise<ResolvedProvider | null> {
  const providerKey = (await resolveProviderForRun(platformKey)) ?? (process.env.USE_ANTHROPIC ? 'anthropic' : 'openai');
  if (!providerKey) {
    return null;
  }

  const normalizedKey = normalizeProviderKey(providerKey);
  const config = await getProviderConfig(normalizedKey);
  if (!config) {
    return null;
  }

  const providerConfig: ProviderConfig = {
    type: normalizedKey,
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
