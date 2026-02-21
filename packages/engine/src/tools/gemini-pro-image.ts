import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import z from 'zod';
import type { Tool } from '../shared/types';

interface GenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
        inlineData?: {
          mimeType?: string;
          data?: string;
        };
        inline_data?: {
          mime_type?: string;
          data?: string;
        };
      }>;
    };
    finishReason?: string;
  }>;
  promptFeedback?: {
    blockReason?: string;
  };
}

const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-pro-image';
const DEFAULT_TIMEOUT = 120000;

export const GeminiProImageTool: Tool<
  {
    prompt: string;
    model?: string;
    outputPath?: string;
    mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
    includeBase64?: boolean;
    timeout?: number;
  },
  {
    model: string;
    text: string;
    mimeType: string;
    outputPath: string;
    bytes: number;
    base64?: string;
  }
> = {
  name: 'gemini_pro_image',
  description:
    'Generate an image with Gemini and save it to local disk. Requires GEMINI_API_KEY. Model defaults to GEMINI_PRO_IMAGE_MODEL or gemini-pro-image.',
  inputSchema: z.object({
    prompt: z.string().describe('Image generation prompt'),
    model: z.string().optional().describe('Gemini model name. Defaults to GEMINI_PRO_IMAGE_MODEL or gemini-pro-image.'),
    outputPath: z
      .string()
      .optional()
      .describe('Optional output file path. Relative paths resolve from current working directory.'),
    mimeType: z
      .enum(['image/png', 'image/jpeg', 'image/webp'])
      .optional()
      .describe('Preferred image mime type. Defaults to image/png.'),
    includeBase64: z
      .boolean()
      .optional()
      .describe('Include full base64 image data in tool output. Large responses may increase token usage.'),
    timeout: z
      .number()
      .optional()
      .describe('Request timeout in milliseconds. Defaults to 120000 (2 minutes).'),
  }),
  execute: async ({ prompt, model, outputPath, mimeType = 'image/png', includeBase64 = false, timeout = DEFAULT_TIMEOUT }) => {
    if (!prompt.trim()) {
      throw new Error('prompt is required');
    }

    if (timeout <= 0 || timeout > 600000) {
      throw new Error('timeout must be between 1 and 600000 milliseconds');
    }

    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) {
      throw new Error('GEMINI_API_KEY environment variable is not set');
    }

    const resolvedModel = model?.trim() || process.env.GEMINI_PRO_IMAGE_MODEL?.trim() || DEFAULT_MODEL;
    const baseUrl = (process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_BASE_URL).replace(/\/$/, '');
    const endpoint = `${baseUrl}/models/${encodeURIComponent(resolvedModel)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), timeout);

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          contents: [
            {
              role: 'user',
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            responseModalities: ['TEXT', 'IMAGE'],
            responseMimeType: mimeType,
          },
        }),
        signal: abortController.signal,
      });
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      if (isAbort) {
        throw new Error(`Gemini image request timed out after ${timeout}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Gemini image API error: ${response.status} ${response.statusText} - ${errorBody}`);
    }

    const data = (await response.json()) as GenerateResponse;
    const image = extractImage(data);
    if (!image) {
      const blockReason = data.promptFeedback?.blockReason;
      if (blockReason) {
        throw new Error(`Gemini image blocked the request: ${blockReason}`);
      }
      throw new Error('Gemini image response did not include image data');
    }

    const text = extractText(data);
    const finalOutputPath = resolveOutputPath(outputPath, image.mimeType);
    await mkdir(dirname(finalOutputPath), { recursive: true });
    await writeFile(finalOutputPath, Buffer.from(image.base64, 'base64'));

    return {
      model: resolvedModel,
      text,
      mimeType: image.mimeType,
      outputPath: finalOutputPath,
      bytes: Buffer.byteLength(image.base64, 'base64'),
      base64: includeBase64 ? image.base64 : undefined,
    };
  },
};

function extractImage(data: GenerateResponse): { base64: string; mimeType: string } | null {
  for (const candidate of data.candidates ?? []) {
    for (const part of candidate.content?.parts ?? []) {
      const camel = part.inlineData;
      if (camel?.data) {
        return {
          base64: camel.data,
          mimeType: camel.mimeType || 'image/png',
        };
      }

      const snake = part.inline_data;
      if (snake?.data) {
        return {
          base64: snake.data,
          mimeType: snake.mime_type || 'image/png',
        };
      }
    }
  }

  return null;
}

function extractText(data: GenerateResponse): string {
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

function resolveOutputPath(outputPath: string | undefined, mimeType: string): string {
  if (outputPath?.trim()) {
    const normalized = outputPath.trim();
    return isAbsolute(normalized) ? normalized : resolve(process.cwd(), normalized);
  }

  const extension = extensionByMimeType(mimeType);
  const filename = `${Date.now()}-${randomUUID().slice(0, 8)}.${extension}`;
  return join(process.cwd(), '.pulse-coder', 'generated-images', filename);
}

function extensionByMimeType(mimeType: string): string {
  if (mimeType === 'image/jpeg') {
    return 'jpg';
  }

  if (mimeType === 'image/webp') {
    return 'webp';
  }

  return 'png';
}

export default GeminiProImageTool;
