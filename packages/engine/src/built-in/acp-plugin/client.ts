import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { homedir } from 'os';
import path from 'path';

import type {
  AcpCancelInput,
  AcpClient,
  AcpClientConfig,
  AcpClientStatus,
  AcpNewSessionInput,
  AcpNewSessionResult,
  AcpPromptInput,
  AcpPromptResult,
  AcpStdioConfig,
  AcpTransport,
  AcpBridgeStatus,
  AcpSessionBinding,
  AcpSessionStore,
  EnsureSessionInput,
  EnsureSessionResult,
} from './types';

export const ACP_SERVICE_NAME = 'acpBridgeService';
export const DEFAULT_TARGET = 'codex';
export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_SESSION_STORE_PATH = path.join(homedir(), '.pulse-coder', 'acp', 'sessions.json');

const TARGET_CONFIG_PREFIX = 'ACP_TARGET_';

interface AcpTargetHttpConfig extends AcpClientConfig {
  target: string;
}

interface AcpTargetStdioConfig extends AcpStdioConfig {
  target: string;
}

interface MultiTargetClientConfig {
  targets: string[];
  defaultTarget: string;
  httpTargets: Map<string, AcpTargetHttpConfig>;
  stdioTargets: Map<string, AcpTargetStdioConfig>;
}

export class AcpBridgeService {
  private readonly client: AcpClient;

  private readonly sessionStore: AcpSessionStore;

  private readonly defaultTarget: string;

  constructor(input: {
    client: AcpClient;
    sessionStore: AcpSessionStore;
    defaultTarget: string;
  }) {
    this.client = input.client;
    this.sessionStore = input.sessionStore;
    this.defaultTarget = input.defaultTarget;
  }

  getStatus(): AcpBridgeStatus {
    return {
      ...this.client.getStatus(),
      defaultTarget: this.defaultTarget,
    };
  }

  async ensureBoundSession(input: EnsureSessionInput): Promise<EnsureSessionResult> {
    this.assertConfigured();
    const requestedTarget = this.resolveTarget(input.target, false);
    const existing = requestedTarget
      ? await this.sessionStore.get(input.remoteSessionId, requestedTarget)
      : await this.sessionStore.getLatest(input.remoteSessionId);

    if (existing && !input.forceNewSession) {
      return { binding: existing, reused: true };
    }

    const targetForNew = requestedTarget || existing?.target || this.resolveTarget(undefined, true);
    const created = await this.client.createSession({
      target: targetForNew,
      metadata: input.metadata,
    });

    const binding = await this.sessionStore.upsert({
      remoteSessionId: input.remoteSessionId,
      acpSessionId: created.sessionId,
      target: targetForNew,
      metadata: input.metadata,
    });

    return {
      binding,
      reused: false,
    };
  }

  async promptWithBoundSession(input: {
    remoteSessionId: string;
    prompt: string;
    target?: string;
    metadata?: Record<string, unknown>;
    forceNewSession?: boolean;
  }): Promise<{
    binding: AcpSessionBinding;
    reusedSession: boolean;
    text: string;
    finishReason?: string;
    raw: unknown;
  }> {
    const session = await this.ensureBoundSession({
      remoteSessionId: input.remoteSessionId,
      target: input.target,
      metadata: input.metadata,
      forceNewSession: input.forceNewSession,
    });

    const prompted = await this.client.prompt({
      sessionId: session.binding.acpSessionId,
      prompt: input.prompt,
      target: session.binding.target,
      metadata: input.metadata,
    });

    return {
      binding: session.binding,
      reusedSession: session.reused,
      text: prompted.text,
      finishReason: prompted.finishReason,
      raw: prompted.raw,
    };
  }

  async cancelBoundSession(input: {
    remoteSessionId: string;
    target?: string;
    reason?: string;
    dropBinding?: boolean;
  }): Promise<{
    found: boolean;
    canceled: boolean;
    binding?: AcpSessionBinding;
    raw?: unknown;
  }> {
    this.assertConfigured();
    const requestedTarget = this.resolveTarget(input.target, false);
    const binding = requestedTarget
      ? await this.sessionStore.get(input.remoteSessionId, requestedTarget)
      : await this.sessionStore.getLatest(input.remoteSessionId);

    if (!binding) {
      return {
        found: false,
        canceled: false,
      };
    }

    const canceled = await this.client.cancel({
      sessionId: binding.acpSessionId,
      target: binding.target,
      reason: input.reason,
    });

    if (input.dropBinding) {
      await this.sessionStore.remove(binding.remoteSessionId, binding.target);
    }

    return {
      found: true,
      canceled: true,
      binding,
      raw: canceled.raw,
    };
  }

  private resolveTarget(primary?: string, requireDefault = true): string {
    const fromPrimary = primary?.trim();
    if (fromPrimary) {
      return fromPrimary;
    }

    if (!requireDefault) {
      return '';
    }

    const fromDefault = this.defaultTarget.trim();
    if (fromDefault) {
      return fromDefault;
    }

    throw new Error('ACP target is missing. Provide target or set ACP_DEFAULT_TARGET.');
  }

  private assertConfigured(): void {
    if (!this.client.isConfigured()) {
      throw new Error('ACP bridge is not configured. Set ACP_BRIDGE_BASE_URL or ACP_TARGETS first.');
    }
  }
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: unknown;
}

type JsonRpcMessage = JsonRpcRequest | JsonRpcResponse | JsonRpcNotification;

interface PendingRequest {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
}

interface JsonRpcClientOptions {
  timeoutMs: number;
  name: string;
}

class StdioJsonRpcClient {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly emitter = new EventEmitter();
  private buffer = '';
  private closed = false;
  private readonly proc;

  constructor(
    command: string,
    args: string[] | undefined,
    env: Record<string, string> | undefined,
    cwd: string | undefined,
    options: JsonRpcClientOptions,
  ) {
    this.proc = spawn(command, args ?? [], {
      env: env ? { ...process.env, ...env } : process.env,
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', chunk => this.handleStdout(chunk));
    this.proc.stderr.setEncoding('utf8');
    this.proc.stderr.on('data', chunk => {
      this.emitter.emit('stderr', chunk);
    });
  }

  on(event: 'notification' | 'stderr', handler: (payload: unknown) => void): void {
    this.emitter.on(event, handler);
  }

  async request(method: string, params: unknown, timeoutMs: number): Promise<JsonRpcResponse> {
    if (!this.proc.stdin || this.closed) {
      throw new Error('ACP stdio process is not available.');
    }

    const id = randomUUID();
    const payload: JsonRpcRequest = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    const responsePromise = new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP stdio request timeout (${method})`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    const encoded = `${JSON.stringify(payload)}\n`;
    this.proc.stdin.write(encoded, 'utf8');

    const response = await responsePromise;
    return response;
  }

  private handleStdout(chunk: string): void {
    if (!chunk) {
      return;
    }

    this.buffer += chunk;
    let index = this.buffer.indexOf('\n');
    while (index >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      index = this.buffer.indexOf('\n');

      if (!line) {
        continue;
      }

      let parsed: JsonRpcMessage | null = null;
      try {
        parsed = JSON.parse(line) as JsonRpcMessage;
      } catch (error) {
        console.warn('[ACP stdio] failed to parse jsonrpc message:', error);
      }

      if (parsed && 'id' in parsed) {
        const pending = this.pending.get(parsed.id);
        if (pending) {
          this.pending.delete(parsed.id);
          if (pending.timer) {
            clearTimeout(pending.timer);
          }
          pending.resolve(parsed);
          continue;
        }
      }

      if (parsed && 'method' in parsed) {
        this.emitter.emit('notification', parsed);
      }
    }
  }
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

function ensureLeadingSlash(value: string, fallback: string): string {
  if (!value) {
    return fallback;
  }
  return value.startsWith('/') ? value : `/${value}`;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (!value) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    return fallback;
  }
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function parseArgs(value: string | undefined): string[] | undefined {
  if (!value) {
    return undefined;
  }
  const entries = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
  return entries.length ? entries : undefined;
}

function parseEnvPairs(value: string | undefined): Record<string, string> | undefined {
  if (!value) {
    return undefined;
  }

  const entries = value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean)
    .map(pair => {
      const [key, ...rest] = pair.split('=');
      const normalizedKey = key?.trim();
      if (!normalizedKey) {
        return null;
      }
      return [normalizedKey, rest.join('=').trim()];
    })
    .filter(Boolean) as Array<[string, string]>;

  if (!entries.length) {
    return undefined;
  }

  return Object.fromEntries(entries);
}

function parseTargets(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function getTargetEnv(env: NodeJS.ProcessEnv, target: string, suffix: string): string | undefined {
  return env[`${TARGET_CONFIG_PREFIX}${target.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_${suffix}`];
}

function buildTargetHttpConfig(env: NodeJS.ProcessEnv, target: string): AcpTargetHttpConfig | null {
  const baseUrl = trimSlash(getTargetEnv(env, target, 'BRIDGE_BASE_URL')?.trim() ?? '');
  const apiKey = getTargetEnv(env, target, 'BRIDGE_API_KEY')?.trim() || undefined;
  const timeoutMs = parsePositiveInteger(getTargetEnv(env, target, 'BRIDGE_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS);
  const initializePath = ensureLeadingSlash(getTargetEnv(env, target, 'INITIALIZE_PATH') ?? '', '/initialize');
  const sessionNewPath = ensureLeadingSlash(getTargetEnv(env, target, 'SESSION_NEW_PATH') ?? '', '/session/new');
  const sessionPromptPath = ensureLeadingSlash(getTargetEnv(env, target, 'SESSION_PROMPT_PATH') ?? '', '/session/prompt');
  const sessionCancelPath = ensureLeadingSlash(getTargetEnv(env, target, 'SESSION_CANCEL_PATH') ?? '', '/session/cancel');
  const initializeOptional = parseBoolean(getTargetEnv(env, target, 'INITIALIZE_OPTIONAL'), true);

  if (!baseUrl) {
    return null;
  }

  return {
    target,
    baseUrl,
    apiKey,
    timeoutMs,
    initializePath,
    sessionNewPath,
    sessionPromptPath,
    sessionCancelPath,
    initializeOptional,
  };
}

function buildTargetStdioConfig(env: NodeJS.ProcessEnv, target: string): AcpTargetStdioConfig | null {
  const command = getTargetEnv(env, target, 'STDIO_COMMAND')?.trim() ?? '';
  if (!command) {
    return null;
  }

  return {
    target,
    command,
    args: parseArgs(getTargetEnv(env, target, 'STDIO_ARGS')),
    env: parseEnvPairs(getTargetEnv(env, target, 'STDIO_ENV')),
    cwd: getTargetEnv(env, target, 'STDIO_CWD')?.trim() || undefined,
    timeoutMs: parsePositiveInteger(getTargetEnv(env, target, 'STDIO_TIMEOUT_MS'), DEFAULT_TIMEOUT_MS),
  };
}

function buildMultiTargetConfig(env: NodeJS.ProcessEnv): MultiTargetClientConfig | null {
  const targets = parseTargets(env.ACP_TARGETS);
  if (!targets.length) {
    return null;
  }

  const defaultTarget = env.ACP_DEFAULT_TARGET?.trim() || DEFAULT_TARGET;
  const httpTargets = new Map<string, AcpTargetHttpConfig>();
  const stdioTargets = new Map<string, AcpTargetStdioConfig>();

  for (const target of targets) {
    const httpConfig = buildTargetHttpConfig(env, target);
    if (httpConfig) {
      httpTargets.set(target, httpConfig);
    }

    const stdioConfig = buildTargetStdioConfig(env, target);
    if (stdioConfig) {
      stdioTargets.set(target, stdioConfig);
    }
  }

  if (!httpTargets.size && !stdioTargets.size) {
    return null;
  }

  return {
    targets,
    defaultTarget,
    httpTargets,
    stdioTargets,
  };
}

export function buildMultiTargetClient(env: NodeJS.ProcessEnv): AcpClient {
  const config = buildMultiTargetConfig(env);
  if (!config) {
    return new AcpHttpClient(buildClientConfigFromEnv(env));
  }

  return new AcpMultiClient(config);
}

export function buildClientConfigFromEnv(env: NodeJS.ProcessEnv): AcpClientConfig {
  return {
    baseUrl: trimSlash(env.ACP_BRIDGE_BASE_URL?.trim() ?? ''),
    apiKey: env.ACP_BRIDGE_API_KEY?.trim() || undefined,
    timeoutMs: parsePositiveInteger(env.ACP_BRIDGE_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
    initializePath: ensureLeadingSlash(env.ACP_INITIALIZE_PATH ?? '', '/initialize'),
    sessionNewPath: ensureLeadingSlash(env.ACP_SESSION_NEW_PATH ?? '', '/session/new'),
    sessionPromptPath: ensureLeadingSlash(env.ACP_SESSION_PROMPT_PATH ?? '', '/session/prompt'),
    sessionCancelPath: ensureLeadingSlash(env.ACP_SESSION_CANCEL_PATH ?? '', '/session/cancel'),
    initializeOptional: parseBoolean(env.ACP_INITIALIZE_OPTIONAL, true),
  };
}

export function buildStdioConfigFromEnv(env: NodeJS.ProcessEnv): AcpStdioConfig {
  return {
    command: env.ACP_STDIO_COMMAND?.trim() || '',
    args: parseArgs(env.ACP_STDIO_ARGS),
    env: parseEnvPairs(env.ACP_STDIO_ENV),
    cwd: env.ACP_STDIO_CWD?.trim() || undefined,
    timeoutMs: parsePositiveInteger(env.ACP_STDIO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export function resolveAcpTransport(env: NodeJS.ProcessEnv): AcpTransport {
  const explicit = env.ACP_TRANSPORT?.trim().toLowerCase();
  if (explicit === 'stdio' || explicit === 'http' || explicit === 'multi') {
    return explicit;
  }

  if (env.ACP_TARGETS && env.ACP_TARGETS.trim()) {
    return 'multi';
  }

  if (env.ACP_STDIO_COMMAND && env.ACP_STDIO_COMMAND.trim()) {
    return 'stdio';
  }

  return 'http';
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

function extractSessionId(payload: unknown): string | null {
  const top = readStringField(payload, ['sessionId', 'session_id', 'id']);
  if (top) {
    return top;
  }

  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const nestedData = (payload as Record<string, unknown>).data;
  return readStringField(nestedData, ['sessionId', 'session_id', 'id']) ?? null;
}

function extractText(payload: unknown): string {
  const top = readStringField(payload, ['text', 'output', 'result', 'answer', 'message']);
  if (top) {
    return top;
  }

  if (!payload || typeof payload !== 'object') {
    return '';
  }

  const nestedData = (payload as Record<string, unknown>).data;
  return readStringField(nestedData, ['text', 'output', 'result', 'answer', 'message']) ?? '';
}

function extractFinishReason(payload: unknown): string | undefined {
  const top = readStringField(payload, ['finishReason', 'finish_reason']);
  if (top) {
    return top;
  }

  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const nestedData = (payload as Record<string, unknown>).data;
  return readStringField(nestedData, ['finishReason', 'finish_reason']);
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return { raw };
  }
}

export class AcpHttpClient {
  private readonly config: AcpClientConfig;

  private initializePromise: Promise<void> | null = null;

  constructor(config: AcpClientConfig) {
    this.config = config;
  }

  isConfigured(): boolean {
    return this.config.baseUrl.length > 0;
  }

  getStatus(): AcpClientStatus {
    if (!this.isConfigured()) {
      return { configured: false, timeoutMs: this.config.timeoutMs, transport: 'http' };
    }

    return {
      configured: true,
      baseUrl: this.config.baseUrl,
      timeoutMs: this.config.timeoutMs,
      transport: 'http',
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
      target: input.target,
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
          name: 'pulse-coder-engine/built-in-acp',
          version: '0.1.0',
        },
        capabilities: {
          session: ['new', 'prompt', 'cancel'],
        },
      });
    } catch (error) {
      if (!this.config.initializeOptional) {
        throw error;
      }
      console.warn('[ACP] initialize failed, continuing in optional mode:', error);
    }
  }

  private async postJson(pathname: string, payload: unknown): Promise<unknown> {
    if (!this.isConfigured()) {
      throw new Error('ACP bridge is not configured. Set ACP_BRIDGE_BASE_URL.');
    }

    const url = `${this.config.baseUrl}${pathname}`;
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

class AcpMultiClient implements AcpClient {
  private readonly defaultTarget: string;
  private readonly targets: string[];
  private readonly configuredTargets = new Set<string>();
  private readonly clients = new Map<string, AcpClient>();

  constructor(config: MultiTargetClientConfig) {
    this.defaultTarget = config.defaultTarget;
    this.targets = config.targets;

    for (const [target, httpConfig] of config.httpTargets.entries()) {
      this.clients.set(target, new AcpHttpClient(httpConfig));
      this.configuredTargets.add(target);
    }

    for (const [target, stdioConfig] of config.stdioTargets.entries()) {
      if (this.clients.has(target)) {
        console.warn(`[ACP] target ${target} has both HTTP and stdio config; stdio will override HTTP.`);
      }
      this.clients.set(target, new AcpStdioClient(stdioConfig));
      this.configuredTargets.add(target);
    }
  }

  isConfigured(): boolean {
    return this.configuredTargets.size > 0;
  }

  getStatus(): AcpClientStatus {
    return {
      configured: this.isConfigured(),
      timeoutMs: DEFAULT_TIMEOUT_MS,
      transport: 'multi',
      targets: this.targets,
      configuredTargets: Array.from(this.configuredTargets),
    };
  }

  async ensureInitialized(): Promise<void> {
    const initialized: Promise<void>[] = [];
    for (const client of this.clients.values()) {
      initialized.push(client.ensureInitialized());
    }

    if (!initialized.length) {
      return;
    }

    await Promise.all(initialized);
  }

  async createSession(input: AcpNewSessionInput): Promise<AcpNewSessionResult> {
    const client = this.resolveClient(input.target);
    return client.createSession(input);
  }

  async prompt(input: AcpPromptInput): Promise<AcpPromptResult> {
    const target = input.target || this.defaultTarget;
    const client = this.resolveClient(target);
    return client.prompt({ ...input, target });
  }

  async cancel(input: AcpCancelInput): Promise<{ ok: boolean; raw: unknown }> {
    const target = input.target || this.defaultTarget;
    const client = this.resolveClient(target);
    return client.cancel({ ...input, target });
  }

  private resolveClient(target: string): AcpClient {
    const normalized = target.trim();
    if (!normalized) {
      throw new Error('ACP target is missing. Provide target or set ACP_DEFAULT_TARGET.');
    }

    const client = this.clients.get(normalized);
    if (!client) {
      const configured = Array.from(this.configuredTargets).join(', ') || '(none)';
      throw new Error(`ACP target ${normalized} is not configured. Configured targets: ${configured}`);
    }

    return client;
  }
}

function toOptionalString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  return undefined;
}

function extractTextFromNotification(notification: JsonRpcNotification): string | undefined {
  if (notification.method !== 'session/update') {
    return undefined;
  }

  const params = notification.params as Record<string, unknown> | undefined;
  if (!params) {
    return undefined;
  }

  const text = toOptionalString(params.text) ?? toOptionalString((params as any).message);
  if (text) {
    return text;
  }

  const data = params.data as Record<string, unknown> | undefined;
  return toOptionalString(data?.text) ?? toOptionalString((data as any)?.message);
}

function extractFinishReasonFromNotification(notification: JsonRpcNotification): string | undefined {
  if (notification.method !== 'session/update') {
    return undefined;
  }

  const params = notification.params as Record<string, unknown> | undefined;
  if (!params) {
    return undefined;
  }

  const finishReason = toOptionalString((params as any).finishReason) ?? toOptionalString((params as any).finish_reason);
  if (finishReason) {
    return finishReason;
  }

  const data = params.data as Record<string, unknown> | undefined;
  return toOptionalString((data as any)?.finishReason) ?? toOptionalString((data as any)?.finish_reason);
}

function ensureResultPayload(response: JsonRpcResponse, fallback: unknown): unknown {
  if (response && 'result' in response) {
    return response.result ?? fallback;
  }
  return fallback;
}

export class AcpStdioClient implements AcpClient {
  private readonly config: AcpStdioConfig;
  private readonly rpc: StdioJsonRpcClient | null;
  private initialized = false;

  private pendingText: string | null = null;
  private pendingFinishReason: string | undefined;

  constructor(config: AcpStdioConfig) {
    this.config = config;
    if (!config.command.trim()) {
      this.rpc = null;
      return;
    }

    this.rpc = new StdioJsonRpcClient(config.command, config.args, config.env, config.cwd, {
      timeoutMs: config.timeoutMs,
      name: 'ACP',
    });

    this.rpc.on('notification', (message: unknown) => {
      const notification = message as JsonRpcNotification;
      if (!notification || notification.jsonrpc !== '2.0' || !notification.method) {
        return;
      }

      const text = extractTextFromNotification(notification);
      if (text) {
        this.pendingText = text;
      }

      const finishReason = extractFinishReasonFromNotification(notification);
      if (finishReason) {
        this.pendingFinishReason = finishReason;
      }
    });

    this.rpc.on('stderr', (chunk: unknown) => {
      const text = typeof chunk === 'string' ? chunk.trim() : '';
      if (text) {
        console.warn(`[ACP stdio] ${text}`);
      }
    });
  }

  isConfigured(): boolean {
    return Boolean(this.rpc);
  }

  getStatus(): AcpClientStatus {
    if (!this.isConfigured()) {
      return { configured: false, timeoutMs: this.config.timeoutMs, transport: 'stdio' };
    }

    return {
      configured: true,
      timeoutMs: this.config.timeoutMs,
      transport: 'stdio',
      command: this.config.command,
      env: this.config.env,
      cwd: this.config.cwd,
    };
  }

  async ensureInitialized(): Promise<void> {
    if (this.initialized) {
      return;
    }

    if (!this.rpc) {
      throw new Error('ACP stdio client is not configured. Set ACP_STDIO_COMMAND.');
    }

    const response = await this.rpc.request(
      'initialize',
      {
        client: {
          name: 'pulse-coder-engine/built-in-acp',
          version: '0.1.0',
        },
        capabilities: {
          session: ['new', 'prompt', 'cancel'],
        },
      },
      this.config.timeoutMs,
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    this.initialized = true;
  }

  async createSession(input: AcpNewSessionInput): Promise<AcpNewSessionResult> {
    await this.ensureInitialized();

    if (!this.rpc) {
      throw new Error('ACP stdio client is not configured.');
    }

    const response = await this.rpc.request(
      'session/new',
      {
        target: input.target,
        metadata: input.metadata ?? {},
      },
      this.config.timeoutMs,
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const payload = ensureResultPayload(response, response);
    const sessionId = extractSessionId(payload);
    if (!sessionId) {
      throw new Error('ACP session/new response missing session id');
    }

    return { sessionId, raw: payload };
  }

  async prompt(input: AcpPromptInput): Promise<AcpPromptResult> {
    await this.ensureInitialized();

    if (!this.rpc) {
      throw new Error('ACP stdio client is not configured.');
    }

    this.pendingText = null;
    this.pendingFinishReason = undefined;

    const response = await this.rpc.request(
      'session/prompt',
      {
        sessionId: input.sessionId,
        session_id: input.sessionId,
        target: input.target,
        prompt: input.prompt,
        metadata: input.metadata ?? {},
      },
      this.config.timeoutMs,
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const payload = ensureResultPayload(response, response);
    const text = extractText(payload) || this.pendingText || '';
    const finishReason = extractFinishReason(payload) ?? this.pendingFinishReason;

    return {
      text,
      finishReason,
      raw: payload,
    };
  }

  async cancel(input: AcpCancelInput): Promise<{ ok: boolean; raw: unknown }> {
    await this.ensureInitialized();

    if (!this.rpc) {
      throw new Error('ACP stdio client is not configured.');
    }

    const response = await this.rpc.request(
      'session/cancel',
      {
        sessionId: input.sessionId,
        session_id: input.sessionId,
        target: input.target,
        reason: input.reason,
      },
      this.config.timeoutMs,
    );

    if (response.error) {
      throw new Error(response.error.message);
    }

    const payload = ensureResultPayload(response, response);
    return { ok: true, raw: payload };
  }
}
