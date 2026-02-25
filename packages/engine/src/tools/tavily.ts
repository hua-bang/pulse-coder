import z from 'zod';
import type { Tool } from '../shared/types';
import { truncateOutput } from './utils';
import { tavilyPost } from './tavily-http';

interface TavilySearchResult {
  title?: string;
  url?: string;
  content?: string;
  score?: number;
}

interface TavilySearchResponse {
  results?: TavilySearchResult[];
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

export default TavilyTool;
