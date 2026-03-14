import type { ClarificationRequest } from 'pulse-coder-engine';

export type AcpAgent = 'claude' | 'codex';

export interface AcpChannelState {
  agent: AcpAgent;
  cwd: string;
  sessionId?: string;
}

export interface AcpStateStore {
  getState(platformKey: string): Promise<AcpChannelState | undefined>;
  setState(platformKey: string, state: AcpChannelState): Promise<void>;
  clearState(platformKey: string): Promise<void>;
  updateCwd(platformKey: string, cwd: string): Promise<boolean>;
  saveSessionId(platformKey: string, sessionId: string): Promise<void>;
}

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
  stateStore?: AcpStateStore;
  clientInfo?: {
    name: string;
    title?: string;
    version?: string;
  };
  clientCapabilities?: AcpClientCapabilities;
  commandOverrides?: Partial<Record<AcpAgent, string>>;
}

export interface AcpRunnerResult {
  text: string;
  sessionId: string;
  stopReason: string;
}

export interface PermissionOption {
  optionId: string;
  kind?: string;
  name?: string;
  description?: string;
  [key: string]: unknown;
}

export interface PermissionRequest {
  sessionId?: string;
  toolCall?: Record<string, unknown>;
  options: PermissionOption[];
  rawParams: Record<string, unknown>;
}

export type PermissionOutcome =
  | { outcome: 'selected'; optionId: string }
  | { outcome: 'cancelled' };

export type PermissionRequestHandler = (request: PermissionRequest) => Promise<PermissionOutcome | null>;

export interface AcpClientOptions {
  onPermissionRequest?: PermissionRequestHandler;
  commandOverrides?: Partial<Record<AcpAgent, string>>;
}

export interface AcpClientCapabilities {
  fs?: {
    readTextFile?: boolean;
    writeTextFile?: boolean;
  };
}

export interface AcpInitializeInput {
  protocolVersion: number;
  clientCapabilities?: AcpClientCapabilities;
  clientInfo?: {
    name: string;
    title?: string;
    version?: string;
  };
}

export interface SessionUpdateNotification {
  sessionId: string;
  update: {
    sessionUpdate: 'plan' | 'agent_message_chunk' | 'tool_call' | 'tool_call_update';
    content?: { type: string; text: string };
    toolCallId?: string;
    title?: string;
    kind?: string;
    status?: 'pending' | 'in_progress' | 'completed' | 'cancelled';
    entries?: unknown[];
  };
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: {
    loadSession?: boolean;
    [key: string]: unknown;
  };
  agentInfo: { name: string; title?: string; version?: string };
}

export interface SessionNewResult {
  sessionId: string;
}

export interface PromptResult {
  stopReason: 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';
}
