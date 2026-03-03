import z from 'zod';
import { fetch } from 'undici';
import type { Tool } from 'pulse-coder-engine';

const toolSchema = z.object({
  url: z.string().min(1).describe('Target URL to fetch content for.'),
  timeoutMs: z.number().int().positive().optional().describe('Request timeout in milliseconds.'),
  maxChars: z.number().int().positive().optional().describe('Maximum characters to return.'),
});

type JinaAiReadInput = z.infer<typeof toolSchema>;

interface JinaAiReadResult {
  ok: boolean;
  sourceUrl: string;
  targetUrl: string;
  status: number;
  content: string;
  truncated: boolean;
  error?: string;
}

function normalizeSourceUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `https://${trimmed}`;
}

function buildTargetUrl(rawUrl: string): { sourceUrl: string; targetUrl: string } {
  const trimmed = rawUrl.trim();
  if (trimmed.startsWith('https://r.jina.ai/') || trimmed.startsWith('http://r.jina.ai/')) {
    return { sourceUrl: trimmed, targetUrl: trimmed };
  }

  const sourceUrl = normalizeSourceUrl(trimmed);
  const protocol = sourceUrl.startsWith('https://') ? 'https' : 'http';
  const withoutProtocol = sourceUrl.replace(/^https?:\/\//, '');
  return {
    sourceUrl,
    targetUrl: `https://r.jina.ai/${protocol}://${withoutProtocol}`,
  };
}

export const jinaAiReadTool: Tool<JinaAiReadInput, JinaAiReadResult> = {
  name: 'jina_ai_read',
  description: 'Fetch readable page text via r.jina.ai, including pages behind login walls (e.g., X).',
  inputSchema: toolSchema,
  execute: async (input): Promise<JinaAiReadResult> => {
    const { sourceUrl, targetUrl } = buildTargetUrl(input.url);
    const timeoutMs = input.timeoutMs ?? 20000;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: 'GET',
        headers: {
          'User-Agent': 'pulse-coder/remote-server',
        },
        signal: controller.signal,
      });

      const text = await response.text();
      const maxChars = input.maxChars ?? 0;
      const truncated = maxChars > 0 && text.length > maxChars;
      const content = truncated ? text.slice(0, maxChars) : text;

      if (!response.ok) {
        return {
          ok: false,
          sourceUrl,
          targetUrl,
          status: response.status,
          content,
          truncated,
          error: `Request failed with status ${response.status}`,
        };
      }

      return {
        ok: true,
        sourceUrl,
        targetUrl,
        status: response.status,
        content,
        truncated,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        ok: false,
        sourceUrl,
        targetUrl,
        status: 0,
        content: '',
        truncated: false,
        error: message,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  },
};
