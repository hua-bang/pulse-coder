import { randomUUID } from 'crypto';
import { mkdir, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, resolve } from 'path';
import { Agent } from 'undici';
import z from 'zod';
import type { Tool } from '../shared/types';

// Local-only dispatcher used to bypass the global EnvHttpProxyAgent (enabled by
// NODE_USE_ENV_PROXY=1) when the OpenAI base URL points at a loopback host.
// Routing requests to a local mock/proxy through an HTTP/SOCKS proxy is both
// unnecessary and unstable for large response bodies, so we explicitly opt out
// for those targets only. Remote endpoints continue to use the global proxy.
const localLoopbackDispatcher = new Agent({
  keepAliveTimeout: 5_000,
  connect: { timeout: 10_000 },
  headersTimeout: 300_000,
  bodyTimeout: 0,
});

function shouldBypassProxyForUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === 'localhost'
      || host === '127.0.0.1'
      || host === '::1'
      || host === '[::1]'
      || host.endsWith('.local');
  } catch {
    return false;
  }
}

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
type OpenAIImageApiMode = 'images' | 'responses' | 'responses_stream' | 'auto';

interface OpenAIResponsesImageCandidate {
  base64?: string;
  resultBase64?: string;
  revisedPrompt?: string;
  outputFormat?: OutputFormat;
  textChunks: string[];
}

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash-preview-image-generation';
const DEFAULT_OPENAI_API_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-image-2';
const DEFAULT_TIMEOUT = 300000;

function resolveDefaultTimeout(): number {
  const raw = process.env.OPENAI_IMAGE_TIMEOUT_MS?.trim();
  if (!raw) {
    return DEFAULT_TIMEOUT;
  }
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0 && parsed <= 600_000) {
    return parsed;
  }
  return DEFAULT_TIMEOUT;
}

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
    imageApiMode?: OpenAIImageApiMode;
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
    'Generate an image with GPT/OpenAI by default and save it to local disk. Uses OPENAI_API_KEY plus OPENAI_API_URL. Defaults to OPENAI_IMAGE_MODEL or the latest GPT image model gpt-image-2. For OpenAI-compatible providers, image API mode defaults to synchronous Responses image generation at {apiUrl}/responses. Other providers are available only when explicitly requested.',
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
      .describe('Request timeout in milliseconds. Defaults to OPENAI_IMAGE_TIMEOUT_MS or 300000 (5 minutes).'),
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
    imageApiMode: z
      .enum(['images', 'responses', 'responses_stream', 'auto'])
      .optional()
      .describe('OpenAI/GPT image API mode. "responses" uses synchronous {apiUrl}/responses image_generation, "responses_stream" uses streaming {apiUrl}/responses image_generation, "images" uses {apiUrl}/images/generations, and "auto" falls back to responses if images fails. Defaults to OPENAI_IMAGE_API_MODE or responses.'),
  }),
  execute: async ({ prompt, provider, model, outputPath, includeBase64 = false, timeout, size, quality, outputFormat, imageApiMode }) => {
    if (!prompt.trim()) {
      throw new Error('prompt is required');
    }

    const resolvedTimeout = timeout ?? resolveDefaultTimeout();
    if (resolvedTimeout <= 0 || resolvedTimeout > 600000) {
      throw new Error('timeout must be between 1 and 600000 milliseconds');
    }

    const resolvedProvider = resolveProvider(provider, model);

    if (resolvedProvider === 'openai') {
      return generateOpenAIImage({
        prompt,
        model,
        outputPath,
        includeBase64,
        timeout: resolvedTimeout,
        size,
        quality,
        outputFormat,
        imageApiMode,
      });
    }

    return generateGeminiImage({
      prompt,
      model,
      outputPath,
      includeBase64,
      timeout: resolvedTimeout,
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
  imageApiMode,
}: {
  prompt: string;
  model?: string;
  outputPath?: string;
  includeBase64: boolean;
  timeout: number;
  size?: string;
  quality?: string;
  outputFormat?: OutputFormat;
  imageApiMode?: OpenAIImageApiMode;
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

  const requestedModel = model?.trim();
  const imageModel = requestedModel || process.env.OPENAI_IMAGE_MODEL?.trim() || DEFAULT_OPENAI_MODEL;
  const responsesModel = requestedModel || process.env.OPENAI_IMAGE_RESPONSES_MODEL?.trim() || process.env.OPENAI_RESPONSES_MODEL?.trim() || imageModel;
  const apiUrl = resolveOpenAIApiUrl();
  const mode = resolveOpenAIImageApiMode(imageApiMode);

  const options = {
    prompt,
    outputPath,
    includeBase64,
    timeout,
    size,
    quality,
    outputFormat,
    apiKey,
    apiUrl,
  };

  if (mode === 'responses') {
    return generateOpenAIResponsesImage({
      ...options,
      model: responsesModel,
    });
  }

  if (mode === 'responses_stream') {
    return generateOpenAIResponsesStreamImage({
      ...options,
      model: responsesModel,
    });
  }

  if (mode === 'auto') {
    try {
      return await generateOpenAIImagesApiImage({
        ...options,
        model: imageModel,
      });
    } catch (error) {
      return generateOpenAIResponsesImage({
        ...options,
        model: responsesModel,
        previousError: error,
      });
    }
  }

  return generateOpenAIImagesApiImage({
    ...options,
    model: imageModel,
  });
}

async function generateOpenAIImagesApiImage({
  prompt,
  model,
  outputPath,
  includeBase64,
  timeout,
  size,
  quality,
  outputFormat,
  apiKey,
  apiUrl,
}: {
  prompt: string;
  model: string;
  outputPath?: string;
  includeBase64: boolean;
  timeout: number;
  size?: string;
  quality?: string;
  outputFormat?: OutputFormat;
  apiKey: string;
  apiUrl: string;
}): Promise<{
  provider: ImageProvider;
  model: string;
  text: string;
  mimeType: string;
  outputPath: string;
  bytes: number;
  base64?: string;
}> {
  const endpoint = buildOpenAIImagesEndpoint(apiUrl);

  const requestBody: Record<string, unknown> = {
    model,
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
      ...(shouldBypassProxyForUrl(endpoint) ? { dispatcher: localLoopbackDispatcher } : {}),
    } as RequestInit);
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
    model,
    text,
    base64: image.base64,
    mimeType: image.mimeType,
    outputPath,
    includeBase64,
  });
}

async function generateOpenAIResponsesImage({
  prompt,
  model,
  outputPath,
  includeBase64,
  timeout,
  size,
  quality,
  outputFormat,
  apiKey,
  apiUrl,
  previousError,
}: {
  prompt: string;
  model: string;
  outputPath?: string;
  includeBase64: boolean;
  timeout: number;
  size?: string;
  quality?: string;
  outputFormat?: OutputFormat;
  apiKey: string;
  apiUrl: string;
  previousError?: unknown;
}): Promise<{
  provider: ImageProvider;
  model: string;
  text: string;
  mimeType: string;
  outputPath: string;
  bytes: number;
  base64?: string;
}> {
  const endpoint = buildOpenAIResponsesEndpoint(apiUrl);
  const requestBody: Record<string, unknown> = {
    model,
    input: prompt,
    tools: [buildResponsesImageGenerationTool({ size, quality, outputFormat })],
    tool_choice: { type: 'image_generation' },
    stream: false,
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
      ...(shouldBypassProxyForUrl(endpoint) ? { dispatcher: localLoopbackDispatcher } : {}),
    } as RequestInit);

    const responseText = await response.text();
    const data = parseJson(responseText);
    if (!response.ok) {
      throw new Error(`OpenAI responses image API error: ${response.status} ${response.statusText} - ${extractErrorMessage(data) || responseText}${formatPreviousError(previousError)}`);
    }

    const imageResult = findImageGenerationResult(data);
    if (!imageResult?.result) {
      throw new Error(`OpenAI responses image response did not include image data${formatPreviousError(previousError)}`);
    }

    return saveImageResult({
      provider: 'openai',
      model,
      text: imageResult.revisedPrompt || findResponsesOutputText(data),
      base64: imageResult.result,
      mimeType: outputFormatToMimeType(imageResult.outputFormat || outputFormat),
      outputPath,
      includeBase64,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      throw new Error(`OpenAI responses image request timed out after ${timeout}ms${formatPreviousError(previousError)}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function generateOpenAIResponsesStreamImage({
  prompt,
  model,
  outputPath,
  includeBase64,
  timeout,
  size,
  quality,
  outputFormat,
  apiKey,
  apiUrl,
  previousError,
}: {
  prompt: string;
  model: string;
  outputPath?: string;
  includeBase64: boolean;
  timeout: number;
  size?: string;
  quality?: string;
  outputFormat?: OutputFormat;
  apiKey: string;
  apiUrl: string;
  previousError?: unknown;
}): Promise<{
  provider: ImageProvider;
  model: string;
  text: string;
  mimeType: string;
  outputPath: string;
  bytes: number;
  base64?: string;
}> {
  const endpoint = buildOpenAIResponsesEndpoint(apiUrl);
  const requestBody: Record<string, unknown> = {
    model,
    input: prompt,
    tools: [buildResponsesImageGenerationTool({ size, quality, outputFormat })],
    tool_choice: { type: 'image_generation' },
    stream: true,
  };

  const abortController = new AbortController();
  const timeoutId = setTimeout(() => abortController.abort(), timeout);

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(requestBody),
      signal: abortController.signal,
      ...(shouldBypassProxyForUrl(endpoint) ? { dispatcher: localLoopbackDispatcher } : {}),
    } as RequestInit);

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI responses image stream API error: ${response.status} ${response.statusText} - ${errorBody}${formatPreviousError(previousError)}`);
    }

    const candidate = await parseOpenAIResponsesImageStream(response.body);
    const base64 = candidate.resultBase64 || candidate.base64;
    if (!base64) {
      throw new Error(`OpenAI responses image stream did not include image data${formatPreviousError(previousError)}`);
    }

    return saveImageResult({
      provider: 'openai',
      model,
      text: candidate.revisedPrompt || candidate.textChunks.join('').trim(),
      base64,
      mimeType: outputFormatToMimeType(candidate.outputFormat || outputFormat),
      outputPath,
      includeBase64,
    });
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      throw new Error(`OpenAI responses image stream request timed out after ${timeout}ms${formatPreviousError(previousError)}`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
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

function resolveOpenAIImageApiMode(mode: OpenAIImageApiMode | undefined): OpenAIImageApiMode {
  const fromEnv = process.env.OPENAI_IMAGE_API_MODE?.trim().toLowerCase();
  const value = mode || fromEnv;
  if (value === 'responses' || value === 'responses_stream' || value === 'images' || value === 'auto') {
    return value;
  }
  return 'responses';
}

function isOpenAIImageModel(model: string): boolean {
  return model.startsWith('gpt-image') || model.startsWith('dall-e');
}

function isGeminiImageModel(model: string): boolean {
  return model.startsWith('gemini') || model.includes('/gemini');
}

function resolveOpenAIApiUrl(): string {
  return (process.env.OPENAI_API_URL?.trim() || DEFAULT_OPENAI_API_URL).replace(/\/$/, '');
}

function buildOpenAIImagesEndpoint(baseUrl: string): string {
  if (/\/v\d+(?:\.\d+)?$/.test(baseUrl)) {
    return `${baseUrl}/images/generations`;
  }

  return `${baseUrl}/v1/images/generations`;
}

function buildOpenAIResponsesEndpoint(baseUrl: string): string {
  return `${baseUrl}/responses`;
}

function parseOpenAIImagesResponse(responseText: string): OpenAIImagesResponse | null {
  try {
    return JSON.parse(responseText) as OpenAIImagesResponse;
  } catch {
    return null;
  }
}

function parseJson(responseText: string): unknown {
  try {
    return JSON.parse(responseText);
  } catch {
    return null;
  }
}

function extractErrorMessage(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }

  const error = (value as Record<string, unknown>).error;
  if (!error || typeof error !== 'object' || Array.isArray(error)) {
    return '';
  }

  const message = (error as Record<string, unknown>).message;
  return typeof message === 'string' ? message : '';
}

function findResponsesOutputText(value: unknown): string {
  const chunks: string[] = [];
  collectResponsesOutputText(value, chunks);
  return chunks.join('\n').trim();
}

function collectResponsesOutputText(value: unknown, chunks: string[]): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      collectResponsesOutputText(item, chunks);
    }
    return;
  }

  const record = value as Record<string, unknown>;
  if ((record.type === 'output_text' || record.type === 'text') && typeof record.text === 'string' && record.text.trim()) {
    chunks.push(record.text.trim());
  }

  for (const child of Object.values(record)) {
    collectResponsesOutputText(child, chunks);
  }
}

function buildResponsesImageGenerationTool({
  size,
  quality,
  outputFormat,
}: {
  size?: string;
  quality?: string;
  outputFormat?: OutputFormat;
}): Record<string, unknown> {
  const tool: Record<string, unknown> = { type: 'image_generation' };
  if (size?.trim()) {
    tool.size = size.trim();
  }
  if (quality?.trim()) {
    tool.quality = quality.trim();
  }
  if (outputFormat) {
    tool.output_format = outputFormat;
  }
  return tool;
}

async function parseOpenAIResponsesImageStream(body: Response['body']): Promise<OpenAIResponsesImageCandidate> {
  if (!body) {
    throw new Error('OpenAI responses image stream response did not include a body');
  }

  const candidate: OpenAIResponsesImageCandidate = { textChunks: [] };
  const decoder = new TextDecoder();
  let buffer = '';

  for await (const chunk of body as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = consumeOpenAIResponsesSseBuffer(buffer, candidate);
  }

  buffer += decoder.decode();
  consumeOpenAIResponsesSseBuffer(buffer, candidate, true);
  return candidate;
}

function consumeOpenAIResponsesSseBuffer(
  buffer: string,
  candidate: OpenAIResponsesImageCandidate,
  consumeAll = false,
): string {
  let separatorIndex = findSseEventSeparator(buffer);
  while (separatorIndex !== -1) {
    const rawEvent = buffer.slice(0, separatorIndex);
    buffer = buffer.slice(buffer[separatorIndex] === '\r' ? separatorIndex + 4 : separatorIndex + 2);
    consumeOpenAIResponsesSseEvent(rawEvent, candidate);
    separatorIndex = findSseEventSeparator(buffer);
  }

  if (consumeAll && buffer.trim()) {
    consumeOpenAIResponsesSseEvent(buffer, candidate);
    return '';
  }

  return buffer;
}

function findSseEventSeparator(buffer: string): number {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf === -1) {
    return lf;
  }
  if (lf === -1) {
    return crlf;
  }
  return Math.min(crlf, lf);
}

function consumeOpenAIResponsesSseEvent(rawEvent: string, candidate: OpenAIResponsesImageCandidate): void {
  const dataLines = rawEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  if (dataLines.length === 0) {
    return;
  }

  const payload = dataLines.join('\n').trim();
  if (!payload || payload === '[DONE]') {
    return;
  }

  let event: unknown;
  try {
    event = JSON.parse(payload);
  } catch {
    return;
  }

  updateOpenAIResponsesImageCandidate(event, candidate);
}

function updateOpenAIResponsesImageCandidate(event: unknown, candidate: OpenAIResponsesImageCandidate): void {
  const partial = findStringByKey(event, 'partial_image_b64');
  if (partial) {
    candidate.base64 = partial;
  }

  const imageResult = findImageGenerationResult(event);
  if (imageResult?.result) {
    candidate.resultBase64 = imageResult.result;
  }
  if (imageResult?.revisedPrompt) {
    candidate.revisedPrompt = imageResult.revisedPrompt;
  }
  if (imageResult?.outputFormat) {
    candidate.outputFormat = imageResult.outputFormat;
  }

  const partialOutputFormat = normalizeOutputFormat(findStringByKey(event, 'output_format'));
  if (partialOutputFormat) {
    candidate.outputFormat = partialOutputFormat;
  }

  const textDelta = findTextDelta(event);
  if (textDelta) {
    candidate.textChunks.push(textDelta);
  }
}

function findImageGenerationResult(value: unknown): { result: string; revisedPrompt?: string; outputFormat?: OutputFormat } | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findImageGenerationResult(item);
      if (found) {
        return found;
      }
    }
    return null;
  }

  const record = value as Record<string, unknown>;
  if (record.type === 'image_generation_call' && typeof record.result === 'string') {
    return {
      result: record.result,
      revisedPrompt: typeof record.revised_prompt === 'string' ? record.revised_prompt : undefined,
      outputFormat: normalizeOutputFormat(record.output_format),
    };
  }

  for (const child of Object.values(record)) {
    const found = findImageGenerationResult(child);
    if (found) {
      return found;
    }
  }

  return null;
}

function findStringByKey(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKey(item, key);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  const record = value as Record<string, unknown>;
  if (typeof record[key] === 'string') {
    return record[key];
  }

  for (const child of Object.values(record)) {
    const found = findStringByKey(child, key);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function findTextDelta(event: unknown): string | undefined {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return undefined;
  }

  const record = event as Record<string, unknown>;
  if (record.type === 'response.output_text.delta' && typeof record.delta === 'string') {
    return record.delta;
  }

  return undefined;
}

function normalizeOutputFormat(value: unknown): OutputFormat | undefined {
  if (value === 'png' || value === 'jpeg' || value === 'webp') {
    return value;
  }
  return undefined;
}

function formatPreviousError(error: unknown): string {
  if (!error) {
    return '';
  }
  if (error instanceof Error) {
    return ` (after /v1/images/generations failed: ${error.message})`;
  }
  return ' (after /v1/images/generations failed)';
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
