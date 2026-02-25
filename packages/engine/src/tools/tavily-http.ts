import { truncateOutput } from './utils';

const DEFAULT_BASE_URL = 'https://api.tavily.com';
const DEFAULT_TIMEOUT_MS = 120000;
const MAX_ERROR_BODY_LENGTH = 500;

interface TavilyRequestOptions {
  endpoint: string;
  body: Record<string, unknown>;
  timeout?: number;
}

interface TavilyErrorBody {
  detail?: { error?: string } | string;
  error?: string;
  message?: string;
}

export async function tavilyPost<T>({ endpoint, body, timeout }: TavilyRequestOptions): Promise<T> {
  const apiKey = getApiKey();
  const baseUrl = getBaseUrl();
  const normalizedTimeout = normalizeTimeout(timeout);
  const url = `${baseUrl}${normalizeEndpoint(endpoint)}`;

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), normalizedTimeout);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: buildHeaders(apiKey),
      body: JSON.stringify(stripUndefined(body)),
      signal: abortController.signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      throw new Error(`Tavily request timed out after ${normalizedTimeout}ms`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const rawBody = await response.text();
  if (!response.ok) {
    const detail = extractErrorMessage(rawBody);
    const suffix = detail ? `: ${detail}` : '';
    throw new Error(`Tavily API error (${response.status} ${response.statusText})${suffix}`);
  }

  if (!rawBody) {
    throw new Error('Tavily API returned an empty response body');
  }

  try {
    return JSON.parse(rawBody) as T;
  } catch {
    throw new Error(`Tavily API returned invalid JSON: ${truncateOutput(rawBody)}`);
  }
}

function getApiKey(): string {
  const apiKey = process.env.TAVILY_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('TAVILY_API_KEY environment variable is not set');
  }

  return apiKey;
}

function getBaseUrl(): string {
  return (process.env.TAVILY_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    throw new Error('Tavily endpoint is required');
  }

  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function buildHeaders(apiKey: string): Record<string, string> {
  const projectId = process.env.TAVILY_PROJECT_ID?.trim() || process.env.TAVILY_PROJECT?.trim();

  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
    ...(projectId ? { 'X-Project-ID': projectId } : {}),
  };
}

function normalizeTimeout(timeout: number | undefined): number {
  if (timeout === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }

  if (!Number.isFinite(timeout) || timeout <= 0 || timeout > 600000) {
    throw new Error('timeout must be a number between 1 and 600000 milliseconds');
  }

  return timeout;
}

function stripUndefined(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined));
}

function extractErrorMessage(rawBody: string): string {
  if (!rawBody) {
    return '';
  }

  try {
    const parsed = JSON.parse(rawBody) as TavilyErrorBody;

    if (typeof parsed.detail === 'string' && parsed.detail.trim()) {
      return parsed.detail.trim();
    }

    if (typeof parsed.detail === 'object' && parsed.detail?.error?.trim()) {
      return parsed.detail.error.trim();
    }

    if (parsed.error?.trim()) {
      return parsed.error.trim();
    }

    if (parsed.message?.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // Ignore parse errors and fallback to raw body text.
  }

  return rawBody.slice(0, MAX_ERROR_BODY_LENGTH).trim();
}
