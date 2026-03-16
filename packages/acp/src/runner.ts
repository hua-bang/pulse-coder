import type {
  AcpRunnerInput,
  AcpRunnerResult,
  AcpRunnerCallbacks,
  InitializeResult,
  PermissionOutcome,
  PermissionOption,
  PermissionRequest,
  PromptResult,
  SessionNewResult,
  SessionUpdateNotification,
} from './types.js';
import { AcpClient } from './client.js';
import { FileAcpStateStore } from './state-store.js';

const DEFAULT_CLIENT_INFO = {
  name: 'pulse-acp-client',
  title: 'Pulse ACP Client',
  version: '1.0.0',
};

const DEFAULT_CLIENT_CAPABILITIES = {
  fs: { readTextFile: true, writeTextFile: true },
};

type AcpPermissionMode = 'allow' | 'prompt';

function resolvePermissionMode(): AcpPermissionMode {
  const raw = process.env.ACP_PERMISSION_MODE;
  if (!raw) return 'allow';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'prompt') return 'prompt';
  return 'allow';
}

const DEFAULT_ACP_RETRY_MAX = 2;
const DEFAULT_ACP_RETRY_BASE_DELAY_MS = 750;

type AcpRetryConfig = {
  maxRetries: number;
  baseDelayMs: number;
};

function resolveRetryConfig(): AcpRetryConfig {
  const rawRetries = Number.parseInt(process.env.ACP_RETRY_MAX ?? `${DEFAULT_ACP_RETRY_MAX}`, 10);
  const rawDelay = Number.parseInt(process.env.ACP_RETRY_BASE_DELAY_MS ?? `${DEFAULT_ACP_RETRY_BASE_DELAY_MS}`, 10);
  return {
    maxRetries: Number.isFinite(rawRetries) && rawRetries > 0 ? rawRetries : 0,
    baseDelayMs: Number.isFinite(rawDelay) && rawDelay > 0 ? rawDelay : 0,
  };
}

const PROXY_ENV_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY'];

// These env vars must never be inherited by the ACP child process.
// CLAUDECODE=1 causes Claude Code to refuse launch when it detects a nested session.
const ALWAYS_UNSET_ENV_KEYS = ['CLAUDECODE'];

function resolveDisableProxy(): boolean {
  const raw = process.env.ACP_DISABLE_PROXY;
  if (!raw) return false;
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function hasProxyEnv(): boolean {
  return PROXY_ENV_KEYS.some((key) => Boolean(process.env[key]));
}

function mergeUnsetEnv(base: string[] | undefined, extra: string[]): string[] | undefined {
  if (!base || base.length === 0) return extra.length ? extra : undefined;
  const merged = listDedupe(base.concat(extra));
  return merged.length ? merged : undefined;
}

function listDedupe(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}


export async function runAcp(input: AcpRunnerInput): Promise<AcpRunnerResult> {
  const retryConfig = resolveRetryConfig();
  let sessionId = input.sessionId;
  let lastError: unknown;
  let disableProxy = resolveDisableProxy();
  const proxyAvailable = hasProxyEnv();

  for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt += 1) {
    let hadOutput = false;
    const callbacks = wrapCallbacks(input.callbacks, () => {
      hadOutput = true;
    });

    const unsetEnv = mergeUnsetEnv(
      input.unsetEnv,
      [...ALWAYS_UNSET_ENV_KEYS, ...(disableProxy ? PROXY_ENV_KEYS : [])],
    );

    try {
      return await runAcpOnce({ ...input, sessionId, unsetEnv }, callbacks);
    } catch (err) {
      lastError = err;
      const shouldRetry = shouldRetryAcpError(err, {
        hadOutput,
        abortSignal: input.abortSignal,
        attempt,
        maxRetries: retryConfig.maxRetries,
      });
      if (!shouldRetry) {
        throw err;
      }
      if (!disableProxy && proxyAvailable && isTransientAcpError(err)) {
        console.warn('[acp/runner] transient error detected, retrying without proxy');
        disableProxy = true;
      }
      sessionId = undefined;
      const delayMs = retryConfig.baseDelayMs * Math.max(1, attempt + 1);
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  throw lastError ?? new Error('ACP failed without error');
}

async function runAcpOnce(input: AcpRunnerInput, callbacks?: AcpRunnerCallbacks): Promise<AcpRunnerResult> {
  const permissionMode = resolvePermissionMode();
  const stateStore = input.stateStore ?? new FileAcpStateStore();
  const client = new AcpClient(input.agent, input.cwd, {
    commandOverrides: input.commandOverrides,
    envOverrides: input.envOverrides,
    unsetEnv: input.unsetEnv,
    onPermissionRequest: async (request) => {
      const options = request.options;
      if (permissionMode !== 'prompt' || !callbacks?.onClarificationRequest) {
        return null;
      }

      if (!options || options.length === 0) {
        return { outcome: 'cancelled' };
      }

      const answer = await callbacks.onClarificationRequest(buildPermissionClarification(request));
      const normalized = answer.trim().toLowerCase();
      if (!normalized) {
        return choosePermissionOutcomeFromAnswer(options, '');
      }

      return choosePermissionOutcomeFromAnswer(options, normalized);
    },
  });

  try {
    const clientInfo = input.clientInfo ?? DEFAULT_CLIENT_INFO;
    const clientCapabilities = input.clientCapabilities ?? DEFAULT_CLIENT_CAPABILITIES;
    const initResult = await client.call<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities,
      clientInfo,
    });

    let sessionId = input.sessionId;
    const supportsLoad = initResult.agentCapabilities?.loadSession === true;

    if (sessionId && supportsLoad) {
      try {
        await client.call('session/load', {
          sessionId,
          cwd: input.cwd,
          mcpServers: [],
        });
      } catch (err) {
        console.warn('[acp/runner] session/load failed, starting fresh:', err);
        sessionId = undefined;
      }
    }

    if (!sessionId) {
      const newSession = await client.call<SessionNewResult>('session/new', {
        cwd: input.cwd,
        mcpServers: [],
      });
      sessionId = newSession.sessionId;
    }

    const textChunks: string[] = [];
    const unsub = client.onNotification((method, params) => {
      if (method !== 'session/update') return;

      if (process.env.ACP_DEBUG === '1' || process.env.ACP_DEBUG === 'true') {
        console.error('[acp/runner] session/update raw:', JSON.stringify(params));
      }

      const notif = params as SessionUpdateNotification;
      const { update } = notif;
      if (!update) return;

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const delta = update.content?.text ?? '';
          if (delta) {
            textChunks.push(delta);
            callbacks?.onText?.(delta);
          }
          break;
        }
        case 'tool_call':
        case 'tool_call_update': {
          if (update.status === 'in_progress' || update.status === 'pending') {
            callbacks?.onToolCall?.(buildToolCallSnapshot(update));
          } else if (update.status === 'completed') {
            callbacks?.onToolResult?.({
              toolCallId: update.toolCallId,
              entries: update.entries,
              status: update.status,
            });
          }
          break;
        }
        case 'plan':
          break;
      }
    });

    const abortHandler = () => {
      client.call('session/cancel', { sessionId }).catch(() => {});
    };
    input.abortSignal?.addEventListener('abort', abortHandler);

    let promptResult: PromptResult;
    try {
      promptResult = await client.call<PromptResult>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: input.userText }],
      });
    } finally {
      input.abortSignal?.removeEventListener('abort', abortHandler);
      unsub();
    }

    await stateStore.saveSessionId(input.platformKey, sessionId);

    return {
      text: textChunks.join(''),
      sessionId,
      stopReason: promptResult.stopReason,
    };
  } finally {
    client.kill();
  }
}

function wrapCallbacks(
  callbacks: AcpRunnerCallbacks | undefined,
  markOutput: () => void,
): AcpRunnerCallbacks | undefined {
  if (!callbacks) return undefined;
  return {
    onText: callbacks.onText
      ? (delta) => {
          markOutput();
          callbacks.onText?.(delta);
        }
      : undefined,
    onToolCall: callbacks.onToolCall
      ? (toolCall) => {
          markOutput();
          callbacks.onToolCall?.(toolCall);
        }
      : undefined,
    onToolResult: callbacks.onToolResult
      ? (toolResult) => {
          markOutput();
          callbacks.onToolResult?.(toolResult);
        }
      : undefined,
    onClarificationRequest: callbacks.onClarificationRequest
      ? async (request) => {
          markOutput();
          const handler = callbacks.onClarificationRequest!;
          return handler(request);
        }
      : undefined,
  };
}

function shouldRetryAcpError(
  err: unknown,
  input: {
    hadOutput: boolean;
    abortSignal?: AbortSignal;
    attempt: number;
    maxRetries: number;
  },
): boolean {
  if (input.hadOutput) return false;
  if (input.abortSignal?.aborted) return false;
  if (input.attempt >= input.maxRetries) return false;
  return isTransientAcpError(err);
}

function isTransientAcpError(err: unknown): boolean {
  const code = extractAcpErrorCode(err);
  if (code === -32603) return true;
  const message = typeof (err as { message?: unknown })?.message === 'string'
    ? String((err as { message?: unknown }).message)
    : '';
  const details = extractAcpErrorDetails(err) ?? '';
  const combined = `${message} ${details}`.toLowerCase();
  return combined.includes('query closed before response received')
    || combined.includes('stream disconnected')
    || combined.includes('response stream disconnected')
    || combined.includes('transport error')
    || combined.includes('network error')
    || combined.includes('econnreset')
    || combined.includes('und_err_connect_timeout');
}

function extractAcpErrorCode(err: unknown): number | null {
  if (err && typeof err === 'object') {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'number') return code;
  }
  const message = typeof (err as { message?: unknown })?.message === 'string'
    ? String((err as { message?: unknown }).message)
    : '';
  const match = /ACP error (-?\d+)/.exec(message);
  return match ? Number.parseInt(match[1], 10) : null;
}

function extractAcpErrorDetails(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const data = (err as { data?: unknown }).data;
  if (typeof data === 'string') return data;
  if (!data || typeof data !== 'object') return null;
  const record = data as Record<string, unknown>;
  return typeof record.details === 'string' && record.details.trim()
    ? record.details.trim()
    : null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildPermissionClarification(request: PermissionRequest) {
  const lines: string[] = [];
  const toolLabel = extractToolLabel(request.toolCall);
  if (toolLabel) {
    lines.push(`Tool: ${toolLabel}`);
  }

  const optionLines = request.options.map((option, index) => {
    const displayName = option.name ?? option.optionId;
    const suffix = option.description ? ` - ${option.description}` : '';
    return `${index + 1}. ${displayName}${suffix}`;
  });

  if (optionLines.length > 0) {
    lines.push('Options:');
    lines.push(...optionLines);
  }

  return {
    id: `acp-permission-${Date.now()}`,
    question: 'Allow the ACP agent to proceed with this action? Reply with a number or yes/no.',
    context: lines.length > 0 ? lines.join('\n') : undefined,
    defaultAnswer: '1',
    timeout: 120000,
  };
}

function extractToolLabel(toolCall?: Record<string, unknown>): string | null {
  if (!toolCall) return null;
  const name = readString(toolCall, 'name') ?? readString(toolCall, 'tool') ?? readString(toolCall, 'toolName');
  if (!name) return null;
  const args = (toolCall as { args?: unknown; input?: unknown }).args ?? (toolCall as { input?: unknown }).input;
  if (args === undefined || args === null) {
    return name;
  }
  const serialized = safeSerialize(args);
  return serialized ? `${name} ${serialized}` : name;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function safeSerialize(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function choosePermissionOutcomeFromAnswer(options: PermissionOption[], answer: string): PermissionOutcome {
  if (!options || options.length === 0) {
    return { outcome: 'cancelled' };
  }

  if (/^(y|yes|ok|allow|approve)$/i.test(answer)) {
    return { outcome: 'selected', optionId: options[0].optionId };
  }

  if (/^(n|no|deny|reject|cancel)$/i.test(answer)) {
    const denyOption = findDenyOption(options);
    return denyOption ? { outcome: 'selected', optionId: denyOption.optionId } : { outcome: 'cancelled' };
  }

  const index = Number.parseInt(answer, 10);
  if (Number.isFinite(index) && index > 0 && index <= options.length) {
    return { outcome: 'selected', optionId: options[index - 1].optionId };
  }

  const matched = options.find((option) => matchesOptionLabel(option, answer));
  if (matched) {
    return { outcome: 'selected', optionId: matched.optionId };
  }

  const denyOption = findDenyOption(options);
  return denyOption ? { outcome: 'selected', optionId: denyOption.optionId } : { outcome: 'cancelled' };
}

function matchesOptionLabel(option: PermissionOption, answer: string): boolean {
  const normalized = answer.toLowerCase();
  const optionId = option.optionId.toLowerCase();
  if (optionId.includes(normalized)) return true;
  const name = option.name?.toLowerCase();
  if (name && name.includes(normalized)) return true;
  return false;
}

function findDenyOption(options: PermissionOption[]): PermissionOption | null {
  return options.find((option) => {
    const kind = option.kind?.toLowerCase() ?? '';
    const optionId = option.optionId.toLowerCase();
    return kind === 'reject_once' || kind === 'reject_always' || optionId.includes('reject') || optionId.includes('deny');
  }) ?? null;
}

function buildToolCallSnapshot(update: SessionUpdateNotification['update']): Record<string, unknown> {
  const toolName = resolveToolName(update);
  const args = extractToolArgs(update);
  const snapshot: Record<string, unknown> = {
    toolCallId: update.toolCallId,
    status: update.status,
  };
  if (toolName) {
    snapshot.toolName = toolName;
    snapshot.name = toolName;
  }
  if (args !== undefined) {
    snapshot.args = args;
  }
  return snapshot;
}

function resolveToolName(update: SessionUpdateNotification['update']): string {
  const record = update as Record<string, unknown>;
  return (
    readString(record, 'toolName') ??
    readString(record, 'name') ??
    readString(record, 'tool') ??
    readString(record, 'title') ??
    readString(record, 'kind') ??
    ''
  );
}

function extractToolArgs(update: SessionUpdateNotification['update']): unknown | undefined {
  const record = update as Record<string, unknown>;
  const direct = (record as { toolInput?: unknown; input?: unknown; args?: unknown }).toolInput
    ?? (record as { input?: unknown }).input
    ?? (record as { args?: unknown }).args;
  if (direct !== undefined) {
    return direct;
  }

  const entries = Array.isArray(update.entries) ? update.entries : undefined;
  if (!entries || entries.length === 0) {
    return undefined;
  }

  const payloadEntry = entries.find((entry) => isRecord(entry) && hasAnyKey(entry, ['toolInput', 'input', 'args']));
  if (payloadEntry && isRecord(payloadEntry)) {
    return (payloadEntry as { toolInput?: unknown; input?: unknown; args?: unknown }).toolInput
      ?? (payloadEntry as { input?: unknown }).input
      ?? (payloadEntry as { args?: unknown }).args;
  }

  if (entries.length === 1 && isRecord(entries[0])) {
    const single = entries[0] as Record<string, unknown>;
    const directEntry = (single as { toolInput?: unknown; input?: unknown; args?: unknown }).toolInput
      ?? (single as { input?: unknown }).input
      ?? (single as { args?: unknown }).args;
    if (directEntry !== undefined) {
      return directEntry;
    }
  }

  return undefined;
}

function hasAnyKey(value: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => key in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
