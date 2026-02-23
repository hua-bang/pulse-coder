import type { EmbeddingProvider } from './types.js';
import { clamp, parseBooleanEnv, parseIntegerEnv } from './config/env-utils.js';
import {
  MAX_EMBEDDING_DIMENSIONS,
  MIN_EMBEDDING_DIMENSIONS,
} from './embedding/hash-provider.js';
import { buildOpenAIEmbeddingProviderFromEnv } from './embedding/openai-provider.js';

type EmbeddingStrategy = 'hash' | 'openai';

export interface MemoryEmbeddingRuntimeConfig {
  semanticRecallEnabled: boolean;
  strategy: EmbeddingStrategy;
  embeddingDimensions?: number;
  embeddingProvider?: EmbeddingProvider;
}

const DEFAULT_HASH_DIMENSIONS = 256;

export function resolveMemoryEmbeddingRuntimeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): MemoryEmbeddingRuntimeConfig {
  const semanticRecallEnabled = parseBooleanEnv(env.MEMORY_SEMANTIC_RECALL_ENABLED, true);
  if (!semanticRecallEnabled) {
    console.log('[memory-service] semantic recall disabled via MEMORY_SEMANTIC_RECALL_ENABLED=false');
    return {
      semanticRecallEnabled,
      strategy: 'hash',
    };
  }

  const strategy = parseEmbeddingStrategy(env.MEMORY_EMBEDDING_STRATEGY);
  if (strategy === 'openai') {
    const openAIProvider = buildOpenAIEmbeddingProviderFromEnv(env);
    if (openAIProvider) {
      console.log(
        `[memory-service] embedding strategy=openai model=${openAIProvider.model} dimensions=${openAIProvider.provider.dimensions}`,
      );
      return {
        semanticRecallEnabled,
        strategy,
        embeddingDimensions: openAIProvider.provider.dimensions,
        embeddingProvider: openAIProvider.provider,
      };
    }

    console.warn(
      '[memory-service] MEMORY_EMBEDDING_STRATEGY=openai is set but API key/base URL is missing. Set MEMORY_EMBEDDING_API_KEY and MEMORY_EMBEDDING_API_URL (or OPENAI_* fallbacks). Falling back to hash embeddings.',
    );
  }

  const hashDimensions = clamp(
    parseIntegerEnv(env.MEMORY_EMBEDDING_DIMENSIONS) ?? DEFAULT_HASH_DIMENSIONS,
    MIN_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_DIMENSIONS,
  );

  console.log(`[memory-service] embedding strategy=hash dimensions=${hashDimensions}`);

  return {
    semanticRecallEnabled,
    strategy: 'hash',
    embeddingDimensions: hashDimensions,
  };
}

function parseEmbeddingStrategy(raw: string | undefined): EmbeddingStrategy {
  return raw?.trim().toLowerCase() === 'openai' ? 'openai' : 'hash';
}
