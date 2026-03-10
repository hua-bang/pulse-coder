import { fetch } from 'undici';

interface AcpClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  initializePath: string;
  sessionNewPath: string;
  sessionPromptPath: string;
  sessionCancelPath: string;
  initializeOptional: boolean;
}

export interface AcpNewSessionInput {
  target: string;
  metadata?: Record<string, unknown>;
}

export interface AcpNewSessionResult {
  sessionId: string;
  raw: unknown;
}

export interface AcpPromptInput {
  sessionId: string;
  prompt: string;
  target?: string;
  metadata?: Record<string, unknown>;
}

export interface AcpPromptResult {
  text: string;
  finishReason?: string;
  raw: unknown;
}

export interface AcpCancelInput {
  sessionId: string;
  reason?: string;
}

function trimSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

function readStringField(payload: unknown, keys: string[]): string | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const source = payload as Record<string, unknown>;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return undefined;
}

function ensureLeadingSlash(value: string, fallback: string): string {
  const normalized = value.trim() || fallback;
  return normalized.startsWith('/') ? normalized : `/${normalized}`;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return Math.floor(parsed);
}

function extractSessionId(payload: unknown): string | null {
  const top = readStringField(payload, ['sessionId', 'session_id', 'id']);
  if (top) {
    return top;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const nestedData = (payload as Record<string, unknown>).data;
  const nested = readStringField(nestedData, ['sessionId', 'session_id', 'id']);
  return nested ?? null;
}

function extractText(payload: unknown): string {
  const top = readStringField(payload, ['text', 'output', 'result', 'answer', 'message']);
  if (top) {
    return top;
  }

  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const data = (payload as Record<string, unknown>).data;
  const nested = readStringField(data, ['text', 'output', 'result', 'answer', 'message']);
  if (nested) {
    return nested;
  }

  return '';
}

function extractFinishReason(payload: unknown): string | undefined {
  const top = readStringField(payload, ['finishReason', 'finish_reason']);
  if (top) {
    return top;
  }

  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const data = (payload as Record<string, unknown>).data;
  return readStringField(data, ['finishReason', 'finish_reason']);
}

function buildConfigFromEnv(env: NodeJS.ProcessEnv): AcpClientConfig {
  return {
    baseUrl: trimSlash(env.ACP_BRIDGE_BASE_URL?.trim() ?? ''),
    apiKey: env.ACP_BRIDGE_API_KEY?.trim() || undefined,
    timeoutMs: parsePositiveInteger(env.ACP_BRIDGE_TIMEOUT_MS, 30000),
    initializePath: ensureLeadingSlash(env.ACP_INITIALIZE_PATH ?? '', '/initialize'),
    sessionNewPath: ensureLeadingSlash(env.ACP_SESSION_NEW_PATH ?? '', '/session/new'),
    sessionPromptPath: ensureLeadingSlash(env.ACP_SESSION_PROMPT_PATH ?? '', '/session/prompt'),
    sessionCancelPath: ensureLeadingSlash(env.ACP_SESSION_CANCEL_PATH ?? '', '/session/cancel'),
    initializeOptional: parseBoolean(env.ACP_INITIALIZE_OPTIONAL, true),
  };
}

export class AcpHttpClient {
  private readonly config: AcpClientConfig;

  private initializePromise: Promise<void> | null = null;

  constructor(config: AcpClientConfig) {
    this.config = config;
  }

  static fromEnv(env: NodeJS.ProcessEnv): AcpHttpClient {
    return new AcpHttpClient(buildConfigFromEnv(env));
  }

  isConfigured(): boolean {
    return this.config.baseUrl.length > 0;
  }

  getStatus(): { configured: boolean; baseUrl?: string; timeoutMs: number } {
    if (!this.isConfigured()) {
      return { configured: false, timeoutMs: this.config.timeoutMs };
    }

    return {
      configured: true,
      baseUrl: this.config.baseUrl,
      timeoutMs: this.config.timeoutMs,
    };
  }

  async ensureInitialized(): Promise<void> {
    if (this.initializePromise) {
      await this.initializePromise;
      return;
    }

    this.initializePromise = this.initializeInternal();
    await this.initializePromise;
  }

  async createSession(input: AcpNewSessionInput): Promise<AcpNewSessionResult> {
    await this.ensureInitialized();
    const payload = await this.postJson(this.config.sessionNewPath, {
      target: input.target,
      metadata: input.metadata ?? {},
    });

    const sessionId = extractSessionId(payload);
    if (!sessionId) {
      throw new Error('ACP session/new response missing session id');
    }

    return { sessionId, raw: payload };
  }

  async prompt(input: AcpPromptInput): Promise<AcpPromptResult> {
    await this.ensureInitialized();
    const payload = await this.postJson(this.config.sessionPromptPath, {
      sessionId: input.sessionId,
      session_id: input.sessionId,
      target: input.target,
      prompt: input.prompt,
      metadata: input.metadata ?? {},
    });

    return {
      text: extractText(payload),
      finishReason: extractFinishReason(payload),
      raw: payload,
    };
  }

  async cancel(input: AcpCancelInput): Promise<{ ok: boolean; raw: unknown }> {
    await this.ensureInitialized();
    const payload = await this.postJson(this.config.sessionCancelPath, {
      sessionId: input.sessionId,
      session_id: input.sessionId,
      reason: input.reason,
    });

    return { ok: true, raw: payload };
  }

  private async initializeInternal(): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('ACP bridge is not configured. Set ACP_BRIDGE_BASE_URL.');
    }

    try {
      await this.postJson(this.config.initializePath, {
        client: {
          name: '@pulse-coder/remote-server',
          version: '0.0.1',
        },
        capabilities: {
          session: ['new', 'prompt', 'cancel'],
        },
      });
    } catch (error) {
      if (!this.config.initializeOptional) {
        throw error;
      }
      console.warn('[acp] initialize failed, continuing in optional mode:', error);
    }
  }

  private async postJson(path: string, payload: unknown): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new Error('ACP bridge is not configured. Set ACP_BRIDGE_BASE_URL.');
    }

    const url = `${this.config.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
      };
      if (this.config.apiKey) {
        headers.authorization = `Bearer ${this.config.apiKey}`;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      const rawText = await response.text();
      const parsed = rawText ? safeJsonParse(rawText) : {};

      if (!response.ok) {
        const preview = rawText.slice(0, 300);
        throw new Error(`ACP request failed: ${response.status} ${response.statusText}; body=${preview}`);
      }

      return parsed;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}
