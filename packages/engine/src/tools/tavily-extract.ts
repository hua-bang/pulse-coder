import z from 'zod';
import type { Tool } from '../shared/types';
import { truncateOutput } from './utils';
import { tavilyPost } from './tavily-http';

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

export default TavilyExtractTool;
