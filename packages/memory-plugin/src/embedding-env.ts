import type { EmbeddingProvider } from './types.js';

type EmbeddingStrategy = 'hash' | 'openai';

export interface MemoryEmbeddingRuntimeConfig {
  semanticRecallEnabled: boolean;
  strategy: EmbeddingStrategy;
  embeddingDimensions?: number;
  embeddingProvider?: EmbeddingProvider;
}

interface OpenAIEmbeddingProviderOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  dimensions: number;
  timeoutMs: number;
}

interface OpenAIEmbeddingsResponse {
  data?: Array<{
    embedding?: number[];
  }>;
}

const MIN_EMBEDDING_DIMENSIONS = 64;
const MAX_EMBEDDING_DIMENSIONS = 4096;
const DEFAULT_HASH_DIMENSIONS = 256;
const DEFAULT_OPENAI_DIMENSIONS = 1536;
const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const DEFAULT_OPENAI_TIMEOUT_MS = 15000;

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

class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly model: string;
  private readonly timeoutMs: number;

  constructor(options: OpenAIEmbeddingProviderOptions) {
    this.apiKey = options.apiKey;
    this.endpoint = `${normalizeEmbeddingBaseUrl(options.baseUrl)}/embeddings`;
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.timeoutMs = options.timeoutMs;
  }

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          input: text,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const bodyPreview = await readResponsePreview(response);
        throw new Error(`embedding API request failed with status ${response.status}: ${bodyPreview}`);
      }

      const payload = (await response.json()) as OpenAIEmbeddingsResponse;
      const vector = payload.data?.[0]?.embedding;

      if (!Array.isArray(vector) || vector.length === 0) {
        throw new Error('embedding API response is missing data[0].embedding');
      }

      return vector.map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0));
    } finally {
      clearTimeout(timeout);
    }
  }
}

function buildOpenAIEmbeddingProviderFromEnv(env: Record<string, string | undefined>): {
  provider: EmbeddingProvider;
  model: string;
} | undefined {
  const apiKey = firstNonEmpty(env.MEMORY_EMBEDDING_API_KEY, env.OPENAI_API_KEY);
  const baseUrl = firstNonEmpty(env.MEMORY_EMBEDDING_API_URL, env.OPENAI_API_URL);
  if (!apiKey || !baseUrl) {
    return undefined;
  }

  const model = firstNonEmpty(env.MEMORY_EMBEDDING_MODEL, env.OPENAI_EMBEDDING_MODEL, DEFAULT_OPENAI_MODEL)
    ?? DEFAULT_OPENAI_MODEL;
  const dimensions = clamp(
    parseIntegerEnv(env.MEMORY_EMBEDDING_DIMENSIONS) ?? DEFAULT_OPENAI_DIMENSIONS,
    MIN_EMBEDDING_DIMENSIONS,
    MAX_EMBEDDING_DIMENSIONS,
  );
  const timeoutMs = Math.max(
    1000,
    parseIntegerEnv(env.MEMORY_EMBEDDING_TIMEOUT_MS) ?? DEFAULT_OPENAI_TIMEOUT_MS,
  );

  return {
    provider: new OpenAICompatibleEmbeddingProvider({
      apiKey,
      baseUrl,
      model,
      dimensions,
      timeoutMs,
    }),
    model,
  };
}

function parseEmbeddingStrategy(raw: string | undefined): EmbeddingStrategy {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'openai') {
    return 'openai';
  }
  return 'hash';
}

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseIntegerEnv(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) {
      return trimmed;
    }
  }
  return undefined;
}

function normalizeEmbeddingBaseUrl(value: string): string {
  const trimmed = trimTrailingSlash(value);
  if (trimmed.endsWith('/chat/completions')) {
    return trimmed.slice(0, -'/chat/completions'.length);
  }
  return trimmed;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function readResponsePreview(response: Response): Promise<string> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('application/json')) {
    const text = await response.text();
    return text.slice(0, 300);
  }

  try {
    const payload = await response.json();
    return JSON.stringify(payload).slice(0, 300);
  } catch {
    const text = await response.text();
    return text.slice(0, 300);
  }
}
