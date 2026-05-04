import { promises as fs } from 'fs';
import { fetch, Agent } from 'undici';
import z from 'zod';
import type { Tool, ToolExecutionContext } from 'pulse-coder-engine';
import type { StoredAttachment } from '../attachments.js';

const localLoopbackDispatcher = new Agent({
  keepAliveTimeout: 5_000,
  connect: { timeout: 10_000 },
  headersTimeout: 30_000,
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

function isAbortLikeError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.name === 'AbortError') {
    return true;
  }
  const cause = (error as { cause?: unknown }).cause;
  if (cause instanceof Error && cause.name === 'AbortError') {
    return true;
  }
  return false;
}

interface AnalyzeImageRequestTarget {
  endpoint: string;
  headers: Record<string, string>;
  model: string;
}

interface GeminiGenerateContentResponse {
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

interface OpenAIChatCompletionResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | Array<{ type?: string; text?: string }>;
    };
    finish_reason?: string;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

interface OpenAIResponsesResponse {
  output?: Array<{
    type?: string;
    role?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

type AnalysisProvider = 'openai' | 'gemini';
type DetailLevel = 'auto' | 'low' | 'high';
type OpenAIVisionApiMode = 'responses' | 'chat_completions' | 'auto';

const toolSchema = z.object({
  prompt: z.string().optional().describe('Question or instruction for the image analysis. Defaults to a concise Chinese image analysis prompt.'),
  imagePaths: z.array(z.string().min(1)).optional().describe('Optional local image paths. When omitted, the tool uses runContext.latestAttachments.'),
  maxImages: z.number().int().positive().max(10).optional().describe('Maximum number of images to analyze. Defaults to 6.'),
  timeoutMs: z.number().int().positive().max(600000).optional().describe('Request timeout in milliseconds. Defaults to 120000.'),
  provider: z
    .enum(['openai', 'gpt', 'gemini'])
    .optional()
    .describe('Vision provider. Defaults to "openai"/"gpt". Set "gemini" to use Gemini explicitly.'),
  model: z.string().optional().describe('Vision model name. Defaults to OPENAI_VISION_MODEL or gpt-5.4 for OpenAI; GEMINI_VISION_MODEL or gemini-2.5-flash for Gemini.'),
  detail: z.enum(['auto', 'low', 'high']).optional().describe('OpenAI image detail level. Only sent for OpenAI/GPT requests. Defaults to "auto".'),
  visionApiMode: z
    .enum(['responses', 'chat_completions', 'auto'])
    .optional()
    .describe('OpenAI/GPT vision API mode. "responses" uses {baseUrl}/responses input_image, "chat_completions" uses {baseUrl}/chat/completions image_url, and "auto" falls back to chat_completions if responses fails. Defaults to OPENAI_VISION_API_MODE or responses.'),
});

type AnalyzeImageInput = z.infer<typeof toolSchema>;

interface AnalyzeImageResult {
  ok: boolean;
  provider: AnalysisProvider;
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

const DEFAULT_GEMINI_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
const DEFAULT_OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_OPENAI_MODEL = 'gpt-5.4';
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_MAX_IMAGES = 6;
const DEFAULT_PROMPT = '请按图片顺序描述关键信息，识别文字，提取主体内容，并结合用户上下文回答问题。如果存在多个图片，先分别概述，再总结。';

interface ResolvedImage {
  path: string;
  base64: string;
  mimeType: string;
}

export const analyzeImageTool: Tool<AnalyzeImageInput, AnalyzeImageResult> = {
  name: 'analyze_image',
  description:
    'Analyze one or more local images. Defaults to OpenAI/GPT vision (uses OPENAI_API_KEY plus OPENAI_BASE_URL/OPENAI_API_BASE_URL/OPENAI_API_URL, model OPENAI_VISION_MODEL or gpt-5.4) via {baseUrl}/responses input_image. Set provider="gemini" to use Gemini instead. If imagePaths are omitted, automatically uses runContext.latestAttachments from the latest image message.',
  defer_loading: true,
  inputSchema: toolSchema,
  execute: async (input: AnalyzeImageInput, context?: AnalyzeImageToolContext): Promise<AnalyzeImageResult> => {
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

    const images: ResolvedImage[] = await Promise.all(
      resolvedPaths.map(async (imagePath): Promise<ResolvedImage> => {
        const buffer = await fs.readFile(imagePath);
        return {
          path: imagePath,
          base64: buffer.toString('base64'),
          mimeType: resolveMimeType(imagePath, runContextAttachments),
        };
      }),
    );

    const provider = resolveProvider(input.provider, input.model);
    const source = input.imagePaths?.length ? 'input.imagePaths' : 'runContext.latestAttachments';

    if (provider === 'openai') {
      return analyzeWithOpenAI({
        prompt,
        images,
        timeoutMs,
        model: input.model,
        detail: input.detail ?? 'auto',
        visionApiMode: input.visionApiMode,
        source,
      });
    }

    return analyzeWithGemini({
      prompt,
      images,
      timeoutMs,
      model: input.model,
      source,
    });
  },
};

async function analyzeWithOpenAI({
  prompt,
  images,
  timeoutMs,
  model,
  detail,
  visionApiMode,
  source,
}: {
  prompt: string;
  images: ResolvedImage[];
  timeoutMs: number;
  model?: string;
  detail: DetailLevel;
  visionApiMode?: OpenAIVisionApiMode;
  source: AnalyzeImageResult['source'];
}): Promise<AnalyzeImageResult> {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY environment variable is not set');
  }

  const resolvedModel =
    model?.trim() ||
    process.env.OPENAI_VISION_MODEL?.trim() ||
    process.env.OPENAI_ANALYZE_IMAGE_MODEL?.trim() ||
    DEFAULT_OPENAI_MODEL;
  const baseUrl = resolveOpenAIBaseUrl();
  const mode = resolveOpenAIVisionApiMode(visionApiMode);
  const options = {
    prompt,
    images,
    timeoutMs,
    model: resolvedModel,
    detail,
    source,
    apiKey,
    baseUrl,
  };

  if (mode === 'chat_completions') {
    return analyzeWithOpenAIChatCompletions(options);
  }

  if (mode === 'auto') {
    try {
      return await analyzeWithOpenAIResponses(options);
    } catch (error) {
      return analyzeWithOpenAIChatCompletions({
        ...options,
        previousError: error,
      });
    }
  }

  return analyzeWithOpenAIResponses(options);
}

async function analyzeWithOpenAIResponses({
  prompt,
  images,
  timeoutMs,
  model,
  detail,
  source,
  apiKey,
  baseUrl,
}: {
  prompt: string;
  images: ResolvedImage[];
  timeoutMs: number;
  model: string;
  detail: DetailLevel;
  source: AnalyzeImageResult['source'];
  apiKey: string;
  baseUrl: string;
}): Promise<AnalyzeImageResult> {
  const endpoint = buildOpenAIResponsesEndpoint(baseUrl);
  const requestBody = {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_text', text: prompt },
          ...images.map((image) => ({
            type: 'input_image',
            image_url: `data:${image.mimeType};base64,${image.base64}`,
            detail,
          })),
        ],
      },
    ],
  };

  const responseText = await postOpenAIJson(endpoint, apiKey, requestBody, timeoutMs, 'OpenAI responses image analysis');
  const data = parseOpenAIResponsesResponse(responseText.body);
  if (!responseText.ok) {
    const errorMessage = data?.error?.message || responseText.body;
    throw new Error(`OpenAI responses image analysis API error: ${responseText.status} ${responseText.statusText} - ${errorMessage}`);
  }

  const text = extractOpenAIResponsesText(data);
  if (!text) {
    throw new Error('OpenAI responses image analysis response did not include text');
  }

  return {
    ok: true,
    provider: 'openai',
    model,
    prompt,
    imageCount: images.length,
    imagePaths: images.map((image) => image.path),
    text,
    source,
  };
}

async function analyzeWithOpenAIChatCompletions({
  prompt,
  images,
  timeoutMs,
  model,
  detail,
  source,
  apiKey,
  baseUrl,
  previousError,
}: {
  prompt: string;
  images: ResolvedImage[];
  timeoutMs: number;
  model: string;
  detail: DetailLevel;
  source: AnalyzeImageResult['source'];
  apiKey: string;
  baseUrl: string;
  previousError?: unknown;
}): Promise<AnalyzeImageResult> {
  const endpoint = buildOpenAIChatCompletionsEndpoint(baseUrl);
  const requestBody = {
    model,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          ...images.map((image) => ({
            type: 'image_url',
            image_url: {
              url: `data:${image.mimeType};base64,${image.base64}`,
              detail,
            },
          })),
        ],
      },
    ],
  };

  const responseText = await postOpenAIJson(endpoint, apiKey, requestBody, timeoutMs, 'OpenAI chat completions image analysis');
  const data = parseOpenAIChatCompletionResponse(responseText.body);
  if (!responseText.ok) {
    const errorMessage = data?.error?.message || responseText.body;
    throw new Error(`OpenAI chat completions image analysis API error: ${responseText.status} ${responseText.statusText} - ${errorMessage}${formatPreviousOpenAIError(previousError)}`);
  }

  const text = extractOpenAIChatCompletionText(data);
  if (!text) {
    throw new Error(`OpenAI chat completions image analysis response did not include text${formatPreviousOpenAIError(previousError)}`);
  }

  return {
    ok: true,
    provider: 'openai',
    model,
    prompt,
    imageCount: images.length,
    imagePaths: images.map((image) => image.path),
    text,
    source,
  };
}

async function postOpenAIJson(
  endpoint: string,
  apiKey: string,
  requestBody: unknown,
  timeoutMs: number,
  label: string,
): Promise<{ ok: boolean; status: number; statusText: string; body: string }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = (await fetch(endpoint, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
      ...(shouldBypassProxyForUrl(endpoint) ? { dispatcher: localLoopbackDispatcher } : {}),
    })) as unknown as Response;

    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      body: await response.text(),
    };
  } catch (error) {
    if (isAbortLikeError(error, controller.signal)) {
      throw new Error(`${label} request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function analyzeWithGemini({
  prompt,
  images,
  timeoutMs,
  model,
  source,
}: {
  prompt: string;
  images: ResolvedImage[];
  timeoutMs: number;
  model?: string;
  source: AnalyzeImageResult['source'];
}): Promise<AnalyzeImageResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY environment variable is not set');
  }

  const baseUrl = (process.env.GEMINI_API_BASE_URL?.trim() || DEFAULT_GEMINI_BASE_URL).replace(/\/$/, '');
  const resolvedModel =
    model?.trim() ||
    process.env.GEMINI_ANALYZE_IMAGE_MODEL?.trim() ||
    process.env.GEMINI_VISION_MODEL?.trim() ||
    DEFAULT_GEMINI_MODEL;
  const requestTarget = buildGeminiGenerateRequestTarget(baseUrl, resolvedModel, apiKey);

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = (await fetch(requestTarget.endpoint, {
      method: 'POST',
      headers: requestTarget.headers,
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              ...images.map((image) => ({
                inlineData: {
                  mimeType: image.mimeType,
                  data: image.base64,
                },
              })),
            ],
          },
        ],
      }),
      signal: controller.signal,
    })) as unknown as Response;
  } catch (error) {
    const isAbort = error instanceof Error && error.name === 'AbortError';
    if (isAbort) {
      throw new Error(`Gemini image analysis request timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Gemini image analysis API error: ${response.status} ${response.statusText} - ${body}`);
  }

  const data = (await response.json()) as GeminiGenerateContentResponse;
  const text = extractGeminiText(data);
  if (!text) {
    const blockReason = data.promptFeedback?.blockReason;
    if (blockReason) {
      throw new Error(`Gemini image analysis blocked the request: ${blockReason}`);
    }
    throw new Error('Gemini image analysis response did not include text');
  }

  return {
    ok: true,
    provider: 'gemini',
    model: requestTarget.model,
    prompt,
    imageCount: images.length,
    imagePaths: images.map((image) => image.path),
    text,
    source,
  };
}

function resolveProvider(provider: AnalyzeImageInput['provider'], model: string | undefined): AnalysisProvider {
  if (provider === 'gpt' || provider === 'openai') {
    return 'openai';
  }
  if (provider === 'gemini') {
    return 'gemini';
  }

  const requestedModel = model?.trim().toLowerCase();
  if (requestedModel) {
    if (requestedModel.startsWith('gpt-') || requestedModel.startsWith('o1') || requestedModel.startsWith('o3')) {
      return 'openai';
    }
    if (requestedModel.startsWith('gemini') || requestedModel.includes('/gemini')) {
      return 'gemini';
    }
  }

  return 'openai';
}

function resolveOpenAIBaseUrl(): string {
  return (
    process.env.OPENAI_BASE_URL?.trim() ||
    process.env.OPENAI_API_BASE_URL?.trim() ||
    process.env.OPENAI_API_URL?.trim() ||
    DEFAULT_OPENAI_BASE_URL
  ).replace(/\/$/, '');
}

function buildOpenAIResponsesEndpoint(baseUrl: string): string {
  return `${baseUrl}/responses`;
}

function buildOpenAIChatCompletionsEndpoint(baseUrl: string): string {
  if (/\/v\d+(?:\.\d+)?$/.test(baseUrl)) {
    return `${baseUrl}/chat/completions`;
  }
  return `${baseUrl}/v1/chat/completions`;
}

function parseOpenAIResponsesResponse(responseText: string): OpenAIResponsesResponse | null {
  try {
    return JSON.parse(responseText) as OpenAIResponsesResponse;
  } catch {
    return null;
  }
}

function parseOpenAIChatCompletionResponse(responseText: string): OpenAIChatCompletionResponse | null {
  return parseOpenAIResponse(responseText);
}

function extractOpenAIResponsesText(data: OpenAIResponsesResponse | null): string {
  if (!data?.output?.length) {
    return '';
  }

  const chunks: string[] = [];
  for (const output of data.output) {
    for (const content of output.content ?? []) {
      if ((content.type === 'output_text' || content.type === 'text') && content.text?.trim()) {
        chunks.push(content.text.trim());
      }
    }
  }

  return chunks.join('\n').trim();
}

function extractOpenAIChatCompletionText(data: OpenAIChatCompletionResponse | null): string {
  return extractOpenAIText(data);
}

function resolveOpenAIVisionApiMode(input?: OpenAIVisionApiMode): OpenAIVisionApiMode {
  const raw = input || process.env.OPENAI_VISION_API_MODE?.trim();
  if (raw === 'responses' || raw === 'chat_completions' || raw === 'auto') {
    return raw;
  }
  return 'responses';
}

function formatPreviousOpenAIError(error: unknown): string {
  if (!error) {
    return '';
  }
  const message = error instanceof Error ? error.message : String(error);
  return ` (previous responses error: ${message})`;
}

function parseOpenAIResponse(responseText: string): OpenAIChatCompletionResponse | null {
  try {
    return JSON.parse(responseText) as OpenAIChatCompletionResponse;
  } catch {
    return null;
  }
}

function extractOpenAIText(data: OpenAIChatCompletionResponse | null): string {
  if (!data?.choices?.length) {
    return '';
  }

  const chunks: string[] = [];
  for (const choice of data.choices) {
    const content = choice.message?.content;
    if (typeof content === 'string') {
      if (content.trim()) {
        chunks.push(content.trim());
      }
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (part?.type === 'text' && typeof part.text === 'string' && part.text.trim()) {
          chunks.push(part.text.trim());
        }
      }
    }
  }

  return chunks.join('\n').trim();
}

function extractRunContextAttachments(runContext?: Record<string, any>): StoredAttachment[] {
  const raw = runContext?.latestAttachments ?? runContext?.attachments;
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .filter((item): item is StoredAttachment => Boolean(item) && typeof item === 'object' && typeof (item as StoredAttachment).path === 'string')
    .map((item) => ({ ...item }));
}

function extractGeminiText(data: GeminiGenerateContentResponse): string {
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

function buildGeminiGenerateRequestTarget(baseUrl: string, model: string, apiKey: string): AnalyzeImageRequestTarget {
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
