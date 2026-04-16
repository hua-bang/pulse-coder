import { promises as fs } from 'fs';
import { fetch } from 'undici';
import z from 'zod';
import type { Tool, ToolExecutionContext } from 'pulse-coder-engine';
import type { StoredAttachment } from '../attachments.js';

interface AnalyzeImageRequestTarget {
  endpoint: string;
  headers: Record<string, string>;
  model: string;
}

interface GenerateContentResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
}

const toolSchema = z.object({
  prompt: z.string().optional().describe('Question or instruction for the image analysis. Defaults to a concise Chinese image analysis prompt.'),
  imagePaths: z.array(z.string().min(1)).optional().describe('Optional local image paths. When omitted, the tool uses runContext.latestAttachments.'),
  maxImages: z.number().int().positive().max(10).optional().describe('Maximum number of images to analyze. Defaults to 6.'),
  timeoutMs: z.number().int().positive().max(600000).optional().describe('Request timeout in milliseconds. Defaults to 120000.'),
});

type AnalyzeImageInput = z.infer<typeof toolSchema>;

interface AnalyzeImageResult {
  ok: boolean;
  model: string;
  prompt: string;
  imageCount: number;
  imagePaths: string[];
  text: string;
  source: 'runContext.latestAttachments' | 'input.imagePaths';
}

interface AnalyzeImageToolContext extends ToolExecutionContext {
  runContext?: Record<string, any>;
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-2.5-flash';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_IMAGES = 6;
const DEFAULT_PROMPT = '请按图片顺序描述关键信息，识别文字，提取主体内容，并结合用户上下文回答问题。如果存在多个图片，先分别概述，再总结。';

type ImageInlinePart = {
  inlineData: {
    mimeType: string;
    data: string;
  };
};

export const analyzeImageTool: Tool<AnalyzeImageInput, AnalyzeImageResult> = {
  name: 'analyze_image',
  description: 'Analyze one or more local images with Gemini. If imagePaths are omitted, automatically uses runContext.latestAttachments from the latest image message.',
  defer_loading: true,
  inputSchema: toolSchema,
  execute: async (input: AnalyzeImageInput, context?: AnalyzeImageToolContext): Promise<AnalyzeImageResult> => {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxImages = input.maxImages ?? DEFAULT_MAX_IMAGES;
    const prompt = input.prompt?.trim() || DEFAULT_PROMPT;

    const runContextAttachments = extractRunContextAttachments(context?.runContext);
    const resolvedPaths = (input.imagePaths?.length ? input.imagePaths : runContextAttachments.map((item) => item.path))
      .map((value: string) => value.trim())
      .filter((value: string) => value.length > 0)
      .slice(0, maxImages);

    if (resolvedPaths.length === 0) {
      throw new Error('No images available. Provide imagePaths or upload images so runContext.latestAttachments is populated.');
    }

    const imageParts: ImageInlinePart[] = await Promise.all(
      resolvedPaths.map(async (imagePath: string): Promise<ImageInlinePart> => {
        const buffer = await fs.readFile(imagePath);
        const mimeType = resolveMimeType(imagePath, runContextAttachments);
        return {
          inlineData: {
            mimeType,
            data: buffer.toString('base64'),
          },
        };
      }),
    );

    const baseUrl = (process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
    const model = process.env.GEMINI_ANALYZE_IMAGE_MODEL?.trim() || process.env.GEMINI_VISION_MODEL?.trim() || DEFAULT_MODEL;
    const requestTarget = buildGenerateRequestTarget(baseUrl, model, apiKey);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetch(requestTarget.endpoint, {
        method: 'POST',
        headers: requestTarget.headers,
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [
                { text: prompt },
                ...imageParts,
              ],
            },
          ],
        }),
        signal: controller.signal,
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (isAbort) {
        throw new Error(`Image analysis request timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Image analysis API error: ${response.status} ${response.statusText} - ${body}`);
    }

    const data = await response.json() as GenerateContentResponse;
    const text = extractText(data);
    if (!text) {
      const blockReason = data.promptFeedback?.blockReason;
      if (blockReason) {
        throw new Error(`Image analysis blocked the request: ${blockReason}`);
      }
      throw new Error('Image analysis response did not include text');
    }

    return {
      ok: true,
      model: requestTarget.model,
      prompt,
      imageCount: resolvedPaths.length,
      imagePaths: resolvedPaths,
      text,
      source: input.imagePaths?.length ? 'input.imagePaths' : 'runContext.latestAttachments',
    };
  },
};

function extractRunContextAttachments(runContext?: Record<string, any>): StoredAttachment[] {
  const raw = runContext?.latestAttachments ?? runContext?.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item): item is StoredAttachment => Boolean(item) && typeof item === 'object' && typeof (item as StoredAttachment).path === 'string')
    .map((item) => ({ ...item }));
}

function extractText(data: GenerateContentResponse): string {
  const chunks: string[] = [];

  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      if (part.text?.trim()) {
        chunks.push(part.text.trim());
      }
    }
  }

  return chunks.join('\n').trim();
}

function resolveMimeType(imagePath: string, attachments: StoredAttachment[]): string {
  const matched = attachments.find((item) => item.path === imagePath);
  if (matched?.mimeType) {
    return matched.mimeType;
  }

  const lower = imagePath.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.webp')) return 'image/webp';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.bmp')) return 'image/bmp';
  return 'application/octet-stream';
}

function buildGenerateRequestTarget(baseUrl: string, model: string, apiKey: string): AnalyzeImageRequestTarget {
  if (isVertexBaseUrl(baseUrl)) {
    const normalizedVertexBaseUrl = baseUrl.replace(/\/v1(?:beta)?$/, '');
    const vertexModel = parseVertexModel(model);

    return {
      endpoint: `${normalizedVertexBaseUrl}/v1/publishers/${encodeURIComponent(vertexModel.provider)}/models/${encodeURIComponent(vertexModel.model)}:generateContent`,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      model: vertexModel.fullModel,
    };
  }

  return {
    endpoint: `${baseUrl}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    headers: {
      'Content-Type': 'application/json',
    },
    model,
  };
}

function isVertexBaseUrl(baseUrl: string): boolean {
  return baseUrl.includes('/api/vertex-ai');
}

function parseVertexModel(model: string): { provider: string; model: string; fullModel: string } {
  const slashIndex = model.indexOf('/');
  if (slashIndex === -1) {
    return {
      provider: 'google',
      model,
      fullModel: `google/${model}`,
    };
  }

  const provider = model.slice(0, slashIndex).trim();
  const modelName = model.slice(slashIndex + 1).trim();
  if (!provider || !modelName) {
    throw new Error(`Invalid Vertex AI model "${model}". Expected "<provider>/<model>".`);
  }

  return {
    provider,
    model: modelName,
    fullModel: `${provider}/${modelName}`,
  };
}
