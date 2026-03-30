import type { Engine, LoopOptions, ILogger } from 'pulse-coder-engine';

/**
 * Engine constructor options.
 * Re-derived from Engine's constructor to avoid depending on unexported EngineOptions.
 */
export type EngineOptions = NonNullable<ConstructorParameters<typeof Engine>[0]>;

// ─── Team ────────────────────────────────────────────────────────────

export type TeamStatus = 'idle' | 'running' | 'completed' | 'failed';

export interface TeamConfig {
  /** Unique team name. */
  name: string;
  /** Directory for team state (tasks, mailbox, config). Defaults to ~/.pulse-coder/teams/<name> */
  stateDir?: string;
  /** Logger instance. */
  logger?: ILogger;
}

export interface TeamMemberInfo {
  /** Unique teammate ID within the team. */
  id: string;
  /** Human-readable name (e.g. "researcher", "security-reviewer"). */
  name: string;
  /** Whether this member is the team lead. */
  isLead: boolean;
  /** Current status. */
  status: TeammateStatus;
}

export interface PersistedTeamConfig {
  name: string;
  createdAt: number;
  members: TeamMemberInfo[];
}

// ─── Teammate ────────────────────────────────────────────────────────

export type TeammateStatus = 'idle' | 'running' | 'stopping' | 'stopped';

export interface TeammateOptions {
  /** Unique ID for this teammate. */
  id: string;
  /** Human-readable name. */
  name: string;
  /** Engine configuration for this teammate's independent Engine instance. */
  engineOptions?: EngineOptions;
  /** Loop options defaults for every run. */
  loopOptions?: Partial<LoopOptions>;
  /** Initial system prompt / spawn prompt from the lead. */
  spawnPrompt?: string;
  /** Model override for this teammate (e.g. 'gpt-4o', 'claude-sonnet-4-20250514'). */
  model?: string;
  /** Whether this teammate should start in plan mode (read-only until approved). */
  requirePlanApproval?: boolean;
  /** Logger instance. */
  logger?: ILogger;
}

// ─── Task List ───────────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

export interface Task {
  /** Unique task ID. */
  id: string;
  /** Short title. */
  title: string;
  /** Detailed description. */
  description: string;
  /** Task status. */
  status: TaskStatus;
  /** IDs of tasks that must complete before this one can be claimed. */
  deps: string[];
  /** ID of the teammate assigned to / who claimed this task. null = unassigned. */
  assignee: string | null;
  /** ID of the teammate who created this task. */
  createdBy: string;
  /** Timestamp when the task was created. */
  createdAt: number;
  /** Timestamp when the task was last updated. */
  updatedAt: number;
  /** Optional result or output from the task. */
  result?: string;
}

export interface CreateTaskInput {
  title: string;
  description: string;
  deps?: string[];
  assignee?: string;
}

// ─── Mailbox ─────────────────────────────────────────────────────────

export type MessageType = 'message' | 'broadcast' | 'shutdown_request' | 'shutdown_response' | 'plan_approval_request' | 'plan_approval_response';

export interface TeamMessage {
  /** Unique message ID. */
  id: string;
  /** Sender teammate ID. */
  from: string;
  /** Recipient teammate ID, or '*' for broadcast. */
  to: string;
  /** Message type. */
  type: MessageType;
  /** Message content. */
  content: string;
  /** Timestamp. */
  timestamp: number;
  /** Whether the recipient has read this message. */
  read: boolean;
}

// ─── Hooks ───────────────────────────────────────────────────────────

export interface TeamHooks {
  /**
   * Runs when a teammate is about to go idle.
   * Return feedback string to keep the teammate working, or undefined to allow idle.
   */
  onTeammateIdle?: (teammateId: string, teammateName: string) => Promise<string | undefined>;
  /**
   * Runs when a task is being created.
   * Return feedback string to prevent creation, or undefined to allow.
   */
  onTaskCreated?: (task: Task) => Promise<string | undefined>;
  /**
   * Runs when a task is being marked complete.
   * Return feedback string to prevent completion, or undefined to allow.
   */
  onTaskCompleted?: (task: Task) => Promise<string | undefined>;
}

// ─── Events ──────────────────────────────────────────────────────────

export type TeamEventType =
  | 'teammate:spawned'
  | 'teammate:idle'
  | 'teammate:stopped'
  | 'teammate:status'
  | 'teammate:output'
  | 'teammate:run_start'
  | 'teammate:run_end'
  | 'task:created'
  | 'task:claimed'
  | 'task:completed'
  | 'task:failed'
  | 'message:sent'
  | 'message:received'
  | 'team:phase'
  | 'team:started'
  | 'team:completed'
  | 'team:cleanup';

export interface TeamEvent {
  type: TeamEventType;
  timestamp: number;
  data: Record<string, any>;
}

export type TeamEventHandler = (event: TeamEvent) => void;

// ─── Display ─────────────────────────────────────────────────────────

export type DisplayMode = 'in-process' | 'tmux' | 'auto';
