
export type AcpTransport = 'http' | 'stdio' | 'multi';

export interface AcpClientConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
  initializePath: string;
  sessionNewPath: string;
  sessionPromptPath: string;
  sessionCancelPath: string;
  initializeOptional: boolean;
}

export interface AcpStdioConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  timeoutMs: number;
}

export interface AcpClientStatus {
  configured: boolean;
  timeoutMs: number;
  transport: AcpTransport;
  baseUrl?: string;
  command?: string;
  env?: Record<string, string>;
  cwd?: string;
  targets?: string[];
  configuredTargets?: string[];
}

export interface AcpClient {
  isConfigured(): boolean;
  getStatus(): AcpClientStatus;
  ensureInitialized(): Promise<void>;
  createSession(input: AcpNewSessionInput): Promise<AcpNewSessionResult>;
  prompt(input: AcpPromptInput): Promise<AcpPromptResult>;
  cancel(input: AcpCancelInput): Promise<{ ok: boolean; raw: unknown }>;
}

export interface AcpSessionBinding {
  remoteSessionId: string;
  acpSessionId: string;
  target: string;
  createdAt: number;
  updatedAt: number;
  metadata?: Record<string, unknown>;
}

export interface AcpSessionStore {
  initialize(): Promise<void>;
  get(remoteSessionId: string, target: string): Promise<AcpSessionBinding | null>;
  getLatest(remoteSessionId: string): Promise<AcpSessionBinding | null>;
  upsert(binding: Omit<AcpSessionBinding, 'createdAt' | 'updatedAt'>): Promise<AcpSessionBinding>;
  remove(remoteSessionId: string, target: string): Promise<void>;
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
  target?: string;
  reason?: string;
}

export interface EnsureSessionInput {
  remoteSessionId: string;
  target?: string;
  metadata?: Record<string, unknown>;
  forceNewSession?: boolean;
}

export interface EnsureSessionResult {
  binding: AcpSessionBinding;
  reused: boolean;
}

export interface AcpBridgeStatus extends AcpClientStatus {
  defaultTarget: string;
}

