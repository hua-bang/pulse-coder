import type { EmbeddingProvider } from '../types.js';
import { firstNonEmpty, parseIntegerEnv } from '../config/env-utils.js';
import { MAX_EMBEDDING_DIMENSIONS, MIN_EMBEDDING_DIMENSIONS } from './hash-provider.js';

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

export interface OpenAIProviderFromEnvResult {
  provider: EmbeddingProvider;
  model: string;
}

const DEFAULT_OPENAI_DIMENSIONS = 1536;
const DEFAULT_OPENAI_MODEL = 'text-embedding-3-small';
const DEFAULT_OPENAI_TIMEOUT_MS = 15000;

export class OpenAICompatibleEmbeddingProvider implements EmbeddingProvider {
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

export function buildOpenAIEmbeddingProviderFromEnv(
  env: Record<string, string | undefined>,
): OpenAIProviderFromEnvResult | undefined {
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
