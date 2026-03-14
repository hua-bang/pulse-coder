/**
 * ACP Runner — drives a full ACP session/prompt turn and maps
 * streaming session/update notifications to the same callbacks
 * that engine.run() uses, so agent-runner.ts can swap them transparently.
 */
import {
  AcpClient,
  type SessionUpdateNotification,
  type InitializeResult,
  type SessionNewResult,
  type PromptResult,
  type PermissionRequest,
  type PermissionOutcome,
  type PermissionOption,
} from './client.js';
import { saveAcpSessionId } from './state.js';
import type { AcpAgent } from './state.js';
import type { ClarificationRequest } from '../types.js';

export interface AcpRunnerCallbacks {
  onText?: (delta: string) => void;
  onToolCall?: (toolCall: unknown) => void;
  onToolResult?: (toolResult: unknown) => void;
  onClarificationRequest?: (request: ClarificationRequest) => Promise<string>;
}

export interface AcpRunnerInput {
  platformKey: string;
  agent: AcpAgent;
  cwd: string;
  sessionId?: string;
  userText: string;
  abortSignal?: AbortSignal;
  callbacks?: AcpRunnerCallbacks;
}

export interface AcpRunnerResult {
  text: string;
  sessionId: string;
  stopReason: string;
}

type AcpPermissionMode = 'allow' | 'prompt';

function resolvePermissionMode(): AcpPermissionMode {
  const raw = process.env.ACP_PERMISSION_MODE;
  if (!raw) return 'allow';
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'prompt') return 'prompt';
  return 'allow';
}

export async function runAcp(input: AcpRunnerInput): Promise<AcpRunnerResult> {
  const permissionMode = resolvePermissionMode();
  const client = new AcpClient(input.agent, input.cwd, {
    onPermissionRequest: async (request) => {
      const options = request.options;
      if (permissionMode !== 'prompt' || !input.callbacks?.onClarificationRequest) {
        return null;
      }

      if (!options || options.length === 0) {
        return { outcome: 'cancelled' };
      }

      const answer = await input.callbacks.onClarificationRequest(buildPermissionClarification(request));
      const normalized = answer.trim().toLowerCase();
      if (!normalized) {
        return choosePermissionOutcomeFromAnswer(options, '');
      }

      return choosePermissionOutcomeFromAnswer(options, normalized);
    },
  });

  try {
    // 1. Handshake — declare fs capabilities so agents can read/write files via us
    const initResult = await client.call<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: { name: 'pulse-remote-server', title: 'Pulse Remote Server', version: '1.0.0' },
    });

    // 2. Session — resume if we have a saved sessionId and the agent supports it
    let sessionId = input.sessionId;
    const supportsLoad = initResult.agentCapabilities?.loadSession === true;

    if (sessionId && supportsLoad) {
      try {
        // session/load replays history via session/update notifications (we ignore them)
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

    // 3. Subscribe to session/update notifications
    const textChunks: string[] = [];
    const unsub = client.onNotification((method, params) => {
      if (method !== 'session/update') return;

      // Log raw notification to help diagnose field mapping issues
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
            input.callbacks?.onText?.(delta);
          }
          break;
        }
        case 'tool_call':
        case 'tool_call_update': {
          if (update.status === 'in_progress' || update.status === 'pending') {
            input.callbacks?.onToolCall?.(buildToolCallSnapshot(update));
          } else if (update.status === 'completed') {
            input.callbacks?.onToolResult?.({
              toolCallId: update.toolCallId,
              entries: update.entries,
              status: update.status,
            });
          }
          break;
        }
        case 'plan':
          // plan updates are informational — no callback needed for now
          break;
      }
    });

    // 4. Abort wiring
    const abortHandler = () => {
      client.call('session/cancel', { sessionId }).catch(() => {});
    };
    input.abortSignal?.addEventListener('abort', abortHandler);

    // 5. Prompt turn
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

    // 6. Persist new sessionId for next turn resume
    await saveAcpSessionId(input.platformKey, sessionId);

    return {
      text: textChunks.join(''),
      sessionId,
      stopReason: promptResult.stopReason,
    };
  } finally {
    client.kill();
  }
}

function buildPermissionClarification(request: PermissionRequest): ClarificationRequest {
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
  const args = toolCall.args ?? toolCall.input;
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
  const direct = record.toolInput ?? record.input ?? record.args;
  if (direct !== undefined) {
    return direct;
  }

  const entries = Array.isArray(update.entries) ? update.entries : undefined;
  if (!entries || entries.length === 0) {
    return undefined;
  }

  const payloadEntry = entries.find((entry) => isRecord(entry) && hasAnyKey(entry, ['toolInput', 'input', 'args']));
  if (payloadEntry && isRecord(payloadEntry)) {
    return payloadEntry.toolInput ?? payloadEntry.input ?? payloadEntry.args;
  }

  if (entries.length === 1 && isRecord(entries[0])) {
    const single = entries[0] as Record<string, unknown>;
    const directEntry = single.toolInput ?? single.input ?? single.args;
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
