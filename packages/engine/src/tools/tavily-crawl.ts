import z from 'zod';
import type { Tool } from '../shared/types';
import { truncateOutput } from './utils';
import { tavilyPost } from './tavily-http';

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

export default TavilyCrawlTool;
