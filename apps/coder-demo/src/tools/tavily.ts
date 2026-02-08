import z from "zod";
import type { Tool } from "../typings";
import { truncateOutput } from "./utils";

const TavilyTool: Tool<
  { query: string; maxResults?: number },
  { results: Array<{ title: string; url: string; content: string; score?: number }> }
> = {
  name: 'tavily',
  description: 'Search the web using Tavily API',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    maxResults: z.number().optional().default(5).describe('Maximum number of results to return'),
  }),
  execute: async ({ query, maxResults = 5 }) => {
    const apiKey = process.env.TAVILY_API_KEY;
    
    if (!apiKey) {
      throw new Error('TAVILY_API_KEY environment variable is not set');
    }

    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        api_key: apiKey,
        query,
        max_results: maxResults,
        search_depth: 'basic',
        include_answer: false,
        include_raw_content: false,
        include_images: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Tavily API error: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    
    return {
      results: data.results?.map((result: any) => ({
        title: result.title || '',
        url: result.url || '',
        content: truncateOutput(result.content || ''),
        score: result.score || 0,
      })) || [],
    };
  },
};

export default TavilyTool;
