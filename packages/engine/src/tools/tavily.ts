import z from 'zod';
import type { Tool } from '../shared/types';
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

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
}

interface TavilyExtractResult {
  url?: string;
  title?: string;
  content?: string;
  raw_content?: string;
  images?: string[];
  favicon?: string;
}

interface TavilyExtractFailure {
  url?: string;
  error?: string;
}

interface TavilyExtractResponse {
  results?: TavilyExtractResult[];
  failed_results?: TavilyExtractFailure[];
  response_time?: number | string;
  request_id?: string;
  usage?: { credits?: number };
}

interface TavilyCrawlResult {
  url?: string;
  title?: string;
  content?: string;
  raw_content?: string;
  images?: string[];
  favicon?: string;
}

interface TavilyCrawlResponse {
  base_url?: string;
  results?: TavilyCrawlResult[];
  response_time?: number | string;
  request_id?: string;
  usage?: { credits?: number };
}

interface TavilyMapResponse {
  base_url?: string;
  results?: string[];
  response_time?: number | string;
  request_id?: string;
  usage?: { credits?: number };
}

export const TavilyTool: Tool<
  { query: string; maxResults?: number; timeout?: number },
  { results: Array<{ title: string; url: string; content: string; score?: number }> }
> = {
  name: 'tavily',
  description: 'Search the web using Tavily API',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    maxResults: z.number().optional().default(5).describe('Maximum number of results to return'),
    timeout: z
      .number()
      .optional()
      .describe('Request timeout in milliseconds. Defaults to 120000 (2 minutes).'),
  }),
  execute: async ({ query, maxResults = 5, timeout }) => {
    const data = await tavilyPost<TavilySearchResponse>({
      endpoint: '/search',
      timeout,
      body: {
        query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      },
    });

    return {
      results:
        data.results?.map((result) => ({
          title: result.title || '',
          url: result.url || '',
          content: truncateOutput(result.content || ''),
          score: result.score || 0,
        })) || [],
    };
  },
};

export const TavilyExtractTool: Tool<
  {
    urls: string[] | string;
    extractDepth?: 'basic' | 'advanced';
    format?: 'markdown' | 'text';
    includeImages?: boolean;
    includeFavicon?: boolean;
    includeUsage?: boolean;
    query?: string;
    chunksPerSource?: number;
    timeout?: number;
  },
  {
    results: Array<{
      url: string;
      title: string;
      content: string;
      rawContent: string;
      images: string[];
      favicon?: string;
    }>;
    failedResults: Array<{ url: string; error: string }>;
    responseTime?: number | string;
    requestId?: string;
    usage?: { credits?: number };
  }
> = {
  name: 'tavily_extract',
  description:
    'Extract cleaned content from one or more URLs via Tavily Extract API. Useful after search to fetch full page text.',
  inputSchema: z.object({
    urls: z
      .union([z.string(), z.array(z.string()).min(1)])
      .describe('One URL or an array of URLs to extract content from.'),
    extractDepth: z
      .enum(['basic', 'advanced'])
      .optional()
      .describe('Extraction depth. advanced is slower and more thorough.'),
    format: z.enum(['markdown', 'text']).optional().describe('Desired response content format.'),
    includeImages: z.boolean().optional().describe('Include image URLs in extraction results.'),
    includeFavicon: z.boolean().optional().describe('Include page favicon URL in each result.'),
    includeUsage: z.boolean().optional().describe('Include Tavily credit usage information in response.'),
    query: z.string().optional().describe('Optional query to rerank extracted chunks by relevance.'),
    chunksPerSource: z
      .number()
      .optional()
      .describe('Maximum extracted chunks to return per source when query is provided.'),
    timeout: z
      .number()
      .optional()
      .describe('Request timeout in milliseconds. Defaults to 120000 (2 minutes).'),
  }),
  execute: async ({
    urls,
    extractDepth,
    format,
    includeImages,
    includeFavicon,
    includeUsage,
    query,
    chunksPerSource,
    timeout,
  }) => {
    const data = await tavilyPost<TavilyExtractResponse>({
      endpoint: '/extract',
      timeout,
      body: {
        urls,
        extract_depth: extractDepth,
        format,
        include_images: includeImages,
        include_favicon: includeFavicon,
        include_usage: includeUsage,
        query,
        chunks_per_source: chunksPerSource,
      },
    });

    return {
      results:
        data.results?.map((result) => ({
          url: result.url || '',
          title: result.title || '',
          content: truncateOutput(result.content || ''),
          rawContent: truncateOutput(result.raw_content || ''),
          images: result.images || [],
          favicon: result.favicon,
        })) || [],
      failedResults:
        data.failed_results?.map((result) => ({
          url: result.url || '',
          error: result.error || '',
        })) || [],
      responseTime: data.response_time,
      requestId: data.request_id,
      usage: data.usage,
    };
  },
};

export const TavilyCrawlTool: Tool<
  {
    url: string;
    maxDepth?: number;
    maxBreadth?: number;
    limit?: number;
    instructions?: string;
    selectPaths?: string[];
    selectDomains?: string[];
    excludePaths?: string[];
    excludeDomains?: string[];
    allowExternal?: boolean;
    includeImages?: boolean;
    includeFavicon?: boolean;
    includeUsage?: boolean;
    extractDepth?: 'basic' | 'advanced';
    format?: 'markdown' | 'text';
    chunksPerSource?: number;
    timeout?: number;
  },
  {
    baseUrl?: string;
    results: Array<{
      url: string;
      title: string;
      content: string;
      rawContent: string;
      images: string[];
      favicon?: string;
    }>;
    responseTime?: number | string;
    requestId?: string;
    usage?: { credits?: number };
  }
> = {
  name: 'tavily_crawl',
  description:
    'Crawl a site from a starting URL and extract page content. Best for collecting docs or multi-page website context.',
  inputSchema: z.object({
    url: z.string().describe('Starting URL to crawl.'),
    maxDepth: z.number().optional().describe('Maximum crawl depth from the starting URL.'),
    maxBreadth: z.number().optional().describe('Maximum number of links followed per page.'),
    limit: z.number().optional().describe('Maximum total pages to crawl.'),
    instructions: z
      .string()
      .optional()
      .describe('Natural language guidance to prioritize specific content while crawling.'),
    selectPaths: z.array(z.string()).optional().describe('Regex patterns to include matching URL paths.'),
    selectDomains: z.array(z.string()).optional().describe('Regex patterns to include specific domains/subdomains.'),
    excludePaths: z.array(z.string()).optional().describe('Regex patterns to exclude matching URL paths.'),
    excludeDomains: z.array(z.string()).optional().describe('Regex patterns to exclude domains/subdomains.'),
    allowExternal: z.boolean().optional().describe('Allow crawling links outside the base domain.'),
    includeImages: z.boolean().optional().describe('Include image URLs in crawl results.'),
    includeFavicon: z.boolean().optional().describe('Include page favicon URL in each result.'),
    includeUsage: z.boolean().optional().describe('Include Tavily credit usage information in response.'),
    extractDepth: z
      .enum(['basic', 'advanced'])
      .optional()
      .describe('Content extraction depth for crawled pages.'),
    format: z.enum(['markdown', 'text']).optional().describe('Desired response content format.'),
    chunksPerSource: z.number().optional().describe('Maximum extracted chunks per crawled source.'),
    timeout: z
      .number()
      .optional()
      .describe('Request timeout in milliseconds. Defaults to 120000 (2 minutes).'),
  }),
  execute: async ({
    url,
    maxDepth,
    maxBreadth,
    limit,
    instructions,
    selectPaths,
    selectDomains,
    excludePaths,
    excludeDomains,
    allowExternal,
    includeImages,
    includeFavicon,
    includeUsage,
    extractDepth,
    format,
    chunksPerSource,
    timeout,
  }) => {
    const data = await tavilyPost<TavilyCrawlResponse>({
      endpoint: '/crawl',
      timeout,
      body: {
        url,
        max_depth: maxDepth,
        max_breadth: maxBreadth,
        limit,
        instructions,
        select_paths: selectPaths,
        select_domains: selectDomains,
        exclude_paths: excludePaths,
        exclude_domains: excludeDomains,
        allow_external: allowExternal,
        include_images: includeImages,
        include_favicon: includeFavicon,
        include_usage: includeUsage,
        extract_depth: extractDepth,
        format,
        chunks_per_source: chunksPerSource,
      },
    });

    return {
      baseUrl: data.base_url,
      results:
        data.results?.map((result) => ({
          url: result.url || '',
          title: result.title || '',
          content: truncateOutput(result.content || ''),
          rawContent: truncateOutput(result.raw_content || ''),
          images: result.images || [],
          favicon: result.favicon,
        })) || [],
      responseTime: data.response_time,
      requestId: data.request_id,
      usage: data.usage,
    };
  },
};

export const TavilyMapTool: Tool<
  {
    url: string;
    maxDepth?: number;
    maxBreadth?: number;
    limit?: number;
    instructions?: string;
    selectPaths?: string[];
    selectDomains?: string[];
    excludePaths?: string[];
    excludeDomains?: string[];
    allowExternal?: boolean;
    includeImages?: boolean;
    includeUsage?: boolean;
    timeout?: number;
  },
  {
    baseUrl?: string;
    results: string[];
    responseTime?: number | string;
    requestId?: string;
    usage?: { credits?: number };
  }
> = {
  name: 'tavily_map',
  description:
    'Discover site URLs from a base page without full content extraction. Best for URL discovery before targeted crawl/extract.',
  inputSchema: z.object({
    url: z.string().describe('Base URL to map.'),
    maxDepth: z.number().optional().describe('Maximum traversal depth from the base URL.'),
    maxBreadth: z.number().optional().describe('Maximum number of links followed per page.'),
    limit: z.number().optional().describe('Maximum number of discovered URLs to return.'),
    instructions: z
      .string()
      .optional()
      .describe('Natural language guidance to prioritize specific URLs during mapping.'),
    selectPaths: z.array(z.string()).optional().describe('Regex patterns to include matching URL paths.'),
    selectDomains: z.array(z.string()).optional().describe('Regex patterns to include specific domains/subdomains.'),
    excludePaths: z.array(z.string()).optional().describe('Regex patterns to exclude matching URL paths.'),
    excludeDomains: z.array(z.string()).optional().describe('Regex patterns to exclude domains/subdomains.'),
    allowExternal: z.boolean().optional().describe('Allow mapping links outside the base domain.'),
    includeImages: z.boolean().optional().describe('Include image links in discovered results.'),
    includeUsage: z.boolean().optional().describe('Include Tavily credit usage information in response.'),
    timeout: z
      .number()
      .optional()
      .describe('Request timeout in milliseconds. Defaults to 120000 (2 minutes).'),
  }),
  execute: async ({
    url,
    maxDepth,
    maxBreadth,
    limit,
    instructions,
    selectPaths,
    selectDomains,
    excludePaths,
    excludeDomains,
    allowExternal,
    includeImages,
    includeUsage,
    timeout,
  }) => {
    const data = await tavilyPost<TavilyMapResponse>({
      endpoint: '/map',
      timeout,
      body: {
        url,
        max_depth: maxDepth,
        max_breadth: maxBreadth,
        limit,
        instructions,
        select_paths: selectPaths,
        select_domains: selectDomains,
        exclude_paths: excludePaths,
        exclude_domains: excludeDomains,
        allow_external: allowExternal,
        include_images: includeImages,
        include_usage: includeUsage,
      },
    });

    return {
      baseUrl: data.base_url,
      results: data.results || [],
      responseTime: data.response_time,
      requestId: data.request_id,
      usage: data.usage,
    };
  },
};

async function tavilyPost<T>({ endpoint, body, timeout }: TavilyRequestOptions): Promise<T> {
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

export default TavilyTool;
