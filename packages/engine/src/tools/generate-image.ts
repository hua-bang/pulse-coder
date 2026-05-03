import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import z from 'zod';
import type { Tool } from '../shared/types';

interface GeminiGenerateResponse {
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

interface OpenAIImagesResponse {
  data?: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface GenerateRequestTarget {
  endpoint: string;
  headers: Record<string, string>;
  model: string;
}

type ImageProvider = 'gemini' | 'openai';
type OutputFormat = 'png' | 'jpeg' | 'webp';

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash-preview-image-generation';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-image-2';
const DEFAULT_TIMEOUT = 120000;

export const GenerateImageTool: Tool<
  {
    prompt: string;
    provider?: ImageProvider | 'gpt';
    model?: string;
    outputPath?: string;
    mimeType?: 'image/png' | 'image/jpeg' | 'image/webp';
    includeBase64?: boolean;
    timeout?: number;
    size?: string;
    quality?: string;
    outputFormat?: OutputFormat;
  },
  {
    provider: ImageProvider;
    model: string;
    text: string;
    mimeType: string;
    outputPath: string;
    bytes: number;
    base64?: string;
  }
> = {
  name: 'generate_image',
  description:
    'Generate an image with GPT/OpenAI by default and save it to local disk. Uses OPENAI_API_KEY plus OPENAI_BASE_URL/OPENAI_API_BASE_URL/OPENAI_API_URL. Defaults to OPENAI_IMAGE_MODEL or the latest GPT image model gpt-image-2. Other providers are available only when explicitly requested.',
  defer_loading: true,
  inputSchema: z.object({
    prompt: z.string().describe('The prompts for image generation need to describe in detail the content, style, and composition of the image you want to generate.'),
    provider: z
      .enum(['gemini', 'openai', 'gpt'])
      .optional()
      .describe('Image provider. Defaults to "openai"/"gpt" for GPT image generation. Set "gemini" explicitly to use Gemini.'),
    model: z.string().optional().describe('Model name. Defaults to OPENAI_IMAGE_MODEL or gpt-image-2 for GPT image generation.'),
    outputPath: z
      .string()
      .optional()
      .describe('Optional output file path. Relative paths resolve from current working directory.'),
    includeBase64: z
      .boolean()
      .optional()
      .describe('Include full base64 image data in tool output. Large responses may increase token usage.'),
    timeout: z
      .number()
      .optional()
      .describe('Request timeout in milliseconds. Defaults to 120000 (2 minutes).'),
    size: z
      .string()
      .optional()
      .describe('OpenAI/GPT image size, for example 1024x1024, 1024x1536, 1536x1024, or auto. Only sent for OpenAI-compatible requests.'),
    quality: z
      .string()
      .optional()
      .describe('OpenAI/GPT image quality, for example auto, low, medium, high, standard, or hd. Only sent for OpenAI-compatible requests.'),
    outputFormat: z
      .enum(['png', 'jpeg', 'webp'])
      .optional()
      .describe('OpenAI/GPT output format. Only sent for OpenAI-compatible requests.'),
  }),
  execute: async ({ prompt, provider, model, outputPath, includeBase64 = false, timeout = DEFAULT_TIMEOUT, size, quality, outputFormat }) => {
    if (!prompt.trim()) {
      throw new Error('prompt is required');
    }

    if (timeout <= 0 || timeout > 600000) {
      throw new Error('timeout must be between 1 and 600000 milliseconds');
    }

    const resolvedProvider = resolveProvider(provider, model);

    if (resolvedProvider === 'openai') {
      return generateOpenAIImage({
        prompt,
        model,
        outputPath,
        includeBase64,
        timeout,
        size,
        quality,
        outputFormat,
      });
    }

    return generateGeminiImage({
      prompt,
      model,
      outputPath,
      includeBase64,
      timeout,
    });
  },
};

async function generateGeminiImage({
  prompt,
  model,
  outputPath,
  includeBase64,
  timeout,
}: {
  prompt: string;
  model?: string;
  outputPath?: string;
  includeBase64: boolean;
  timeout: number;
}): Promise<{
  provider: ImageProvider;
  model: string;
  text: string;
  mimeType: string;
  outputPath: string;
  bytes: number;
  base64?: string;
}> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  const resolvedModel = model?.trim() || process.env.GEMINI_IMAGE_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
  const baseUrl = (process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
  const requestTarget = buildGeminiGenerateRequestTarget(baseUrl, resolvedModel, apiKey);

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(requestTarget.endpoint, {
      method: 'POST',
      headers: requestTarget.headers,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }],
          },
        ],
        generationConfig: {
          responseModalities: ['TEXT', 'IMAGE'],
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

  const data = (await response.json()) as GeminiGenerateResponse;
  const image = extractGeminiImage(data);
  if (!image) {
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini image blocked the request: ${blockReason}`);
    }
    throw new Error('Gemini image response did not include image data');
  }

  const text = extractGeminiText(data);
  return saveImageResult({
    provider: 'gemini',
    model: requestTarget.model,
    text,
    base64: image.base64,
    mimeType: image.mimeType,
    outputPath,
    includeBase64,
  });
}

async function generateOpenAIImage({
  prompt,
  model,
  outputPath,
  includeBase64,
  timeout,
  size,
  quality,
  outputFormat,
}: {
  prompt: string;
  model?: string;
  outputPath?: string;
  includeBase64: boolean;
  timeout: number;
  size?: string;
  quality?: string;
  outputFormat?: OutputFormat;
}): Promise<{
  provider: ImageProvider;
  model: string;
  text: string;
  mimeType: string;
  outputPath: string;
  bytes: number;
  base64?: string;
}> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }

  const resolvedModel = model?.trim() || process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const baseUrl = resolveOpenAIBaseUrl();
  const endpoint = buildOpenAIImagesEndpoint(baseUrl);

  const requestBody: Record<string, unknown> = {
    model: resolvedModel,
    prompt,
  };

  if (size?.trim()) {
    requestBody.size = size.trim();
  }

  if (quality?.trim()) {
    requestBody.quality = quality.trim();
  }

  if (outputFormat) {
    requestBody.output_format = outputFormat;
  }

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      throw new Error(`OpenAI image request timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  const responseText = await response.text();
  const data = parseOpenAIImagesResponse(responseText);
  if (!response.ok) {
    const errorMessage = data?.error?.message || responseText;
    throw new Error(`OpenAI image API error: ${response.status} ${response.statusText} - ${errorMessage}`);
  }

  const image = await extractOpenAIImage(data, outputFormat, timeout);
  if (!image) {
    throw new Error('OpenAI image response did not include image data');
  }

  const text = data?.data?.find((item) => item.revised_prompt?.trim())?.revised_prompt?.trim() || '';
  return saveImageResult({
    provider: 'openai',
    model: resolvedModel,
    text,
    base64: image.base64,
    mimeType: image.mimeType,
    outputPath,
    includeBase64,
  });
}

function resolveProvider(provider: ImageProvider | 'gpt' | undefined, model: string | undefined): ImageProvider {
  if (provider === 'gpt' || provider === 'openai') {
    return 'openai';
  }

  if (provider === 'gemini') {
    return 'gemini';
  }

  const requestedModel = model?.trim().toLowerCase();
  if (requestedModel && isOpenAIImageModel(requestedModel)) {
    return 'openai';
  }

  if (requestedModel && isGeminiImageModel(requestedModel)) {
    return 'gemini';
  }

  return 'openai';
}

function isOpenAIImageModel(model: string): boolean {
  return model.startsWith('gpt-image') || model.startsWith('dall-e');
}

function isGeminiImageModel(model: string): boolean {
  return model.startsWith('gemini') || model.includes('/gemini');
}

function resolveOpenAIBaseUrl(): string {
  return (
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.OPENAI_API_BASE_URL?.trim() ||
    process.env.OPENAI_API_URL?.trim() ||
    DEFAULT_OPENAI_BASE_URL
  ).replace(/\/$/, '');
}

function buildOpenAIImagesEndpoint(baseUrl: string): string {
  if (/\/v\d+(?:\.\d+)?$/.test(baseUrl)) {
    return `${baseUrl}/images/generations`;
  }

  return `${baseUrl}/v1/images/generations`;
}

function parseOpenAIImagesResponse(responseText: string): OpenAIImagesResponse | null {
  try {
    return JSON.parse(responseText) as OpenAIImagesResponse;
  } catch {
    return null;
  }
}

async function extractOpenAIImage(
  data: OpenAIImagesResponse | null,
  outputFormat: OutputFormat | undefined,
  timeout: number,
): Promise<{ base64: string; mimeType: string } | null> {
  const firstImage = data?.data?.[0];
  if (!firstImage) {
    return null;
  }

  if (firstImage.b64_json) {
    return {
      base64: firstImage.b64_json,
      mimeType: outputFormatToMimeType(outputFormat),
    };
  }

  if (firstImage.url) {
    return fetchImageUrlAsBase64(firstImage.url, timeout);
  }

  return null;
}

async function fetchImageUrlAsBase64(url: string, timeout: number): Promise<{ base64: string; mimeType: string }> {
  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(url, { signal: abortController.signal });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      throw new Error(`OpenAI image URL download timed out after ${timeout}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`OpenAI image URL download error: ${response.status} ${response.statusText} - ${errorBody}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  return {
    base64: buffer.toString('base64'),
    mimeType: response.headers.get('content-type')?.split(';')[0] || 'image/png',
  };
}

async function saveImageResult({
  provider,
  model,
  text,
  base64,
  mimeType,
  outputPath,
  includeBase64,
}: {
  provider: ImageProvider;
  model: string;
  text: string;
  base64: string;
  mimeType: string;
  outputPath?: string;
  includeBase64: boolean;
}): Promise<{
  provider: ImageProvider;
  model: string;
  text: string;
  mimeType: string;
  outputPath: string;
  bytes: number;
  base64?: string;
}> {
  const finalOutputPath = resolveOutputPath(outputPath, mimeType);
  await mkdir(dirname(finalOutputPath), { recursive: true });
  await writeFile(finalOutputPath, Buffer.from(base64, 'base64'));

  return {
    provider,
    model,
    text,
    mimeType,
    outputPath: finalOutputPath,
    bytes: Buffer.byteLength(base64, 'base64'),
    base64: includeBase64 ? base64 : undefined,
  };
}

function extractGeminiImage(data: GeminiGenerateResponse): { base64: string; mimeType: string } | null {
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

function extractGeminiText(data: GeminiGenerateResponse): string {
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

function buildGeminiGenerateRequestTarget(baseUrl: string, model: string, apiKey: string): GenerateRequestTarget {
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

function outputFormatToMimeType(outputFormat: OutputFormat | undefined): string {
  if (outputFormat === 'jpeg') {
    return 'image/jpeg';
  }

  if (outputFormat === 'webp') {
    return 'image/webp';
  }

  return 'image/png';
}

export default GenerateImageTool;
