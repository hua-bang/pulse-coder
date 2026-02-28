export type AgentTeamNodeStatus = 'pending' | 'running' | 'success' | 'failed' | 'skipped';

export interface AgentTeamNodeSpec {
  id: string;
  agent: string;
  goalTemplate: string;
  deps: string[];
  timeoutMs: number;
  retries: number;
  optional: boolean;
}

export interface AgentTeamFinalAggregatorSpec {
  mode: 'template' | 'llm';
  template?: string;
  systemPrompt?: string;
}

export interface AgentTeamSpec {
  teamId: string;
  version: string;
  maxParallel: number;
  nodes: AgentTeamNodeSpec[];
  finalAggregator: AgentTeamFinalAggregatorSpec;
  sourcePath: string;
}

export interface AgentTeamNodeResult {
  id: string;
  agent: string;
  status: AgentTeamNodeStatus;
  output?: unknown;
  error?: string;
  attempts: number;
  startedAt?: number;
  endedAt?: number;
}

export interface AgentTeamRunResult {
  runId: string;
  teamId: string;
  status: 'success' | 'failed';
  finalText: string;
  failedNodeCount: number;
  skippedNodeCount: number;
  trace: AgentTeamNodeResult[];
}

export interface AgentTeamRegistrySummary {
  teamId: string;
  version: string;
  nodeCount: number;
  sourcePath: string;
}

export interface AgentTeamRegistryService {
  get(teamId: string): AgentTeamSpec | undefined;
  list(): AgentTeamRegistrySummary[];
  reload(): number;
}
