import z from 'zod';
import type { Tool } from '../shared/types';
import { tavilyPost } from './tavily-http';

interface TavilyMapResponse {
  base_url?: string;
  results?: string[];
  response_time?: number | string;
  request_id?: string;
  usage?: { credits?: number };
}

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

export default TavilyMapTool;
