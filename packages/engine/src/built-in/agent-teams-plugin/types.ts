export type TeamRole =
  | 'researcher'
  | 'executor'
  | 'reviewer'
  | 'writer'
  | 'tester'
  | (string & {});

export type TaskNodeStatus = 'success' | 'failed' | 'skipped';

export interface TaskNode {
  id: string;
  role: TeamRole;
  deps: string[];
  input: string;
  optional?: boolean;
  tool?: string;
}

export interface TaskGraph {
  nodes: TaskNode[];
}

export interface NodeResult {
  nodeId: string;
  role: TeamRole;
  status: TaskNodeStatus;
  toolName?: string;
  output?: string;
  error?: string;
  attempts: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  skippedReason?: string;
}

export interface TeamRunInput {
  task: string;
  context?: Record<string, any>;
  roles?: TeamRole[];
  graph?: TaskGraph;
  route?: 'auto' | 'all';
  includeRoles?: TeamRole[];
  excludeRoles?: TeamRole[];
  roleTools?: Record<string, string>;
  maxConcurrency?: number;
  nodeTimeoutMs?: number;
  retries?: number;
  aggregate?: 'concat';
}

export interface TeamRunOutput {
  task: string;
  roles: TeamRole[];
  graph: TaskGraph;
  results: Record<string, NodeResult>;
  aggregate: string;
}
