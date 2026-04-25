import type { ILogger } from 'pulse-coder-engine';
import type { Mailbox } from '../mailbox.js';
import type { TaskList } from '../task-list.js';

export type AgentRuntimeKind = 'pulse' | 'claude-code' | 'codex';

/**
 * Shared context every runtime needs to wire team capabilities.
 * The host (Teammate) constructs this once per teammate.
 */
export interface RuntimeContext {
  /** Stable id of the teammate this runtime belongs to. */
  teammateId: string;
  /** Human-readable name (used for logs and prompts). */
  teammateName: string;
  /** Working directory for the agent. */
  cwd: string;
  /** Shared mailbox instance — runtime may use it directly or via MCP. */
  mailbox: Mailbox;
  /** Shared task list instance. */
  taskList: TaskList;
  /** Team state directory (used to spawn child processes that share state).
   *  Required for runtimes like ClaudeCodeRuntime that share state via files. */
  stateDir?: string;
  /** Whether plan-approval mode is active for this teammate. */
  requirePlanApproval?: boolean;
  /** Logger. */
  logger?: ILogger;
}

/** Options for a single agent turn. */
export interface RuntimeRunOptions {
  /** User-facing prompt for this turn (already includes any pending mailbox preamble). */
  prompt: string;
  /** System prompt / role description. */
  systemPrompt: string;
  /** Cancellation. */
  abortSignal: AbortSignal;
  /** Stream of assistant text chunks. */
  onText?: (delta: string) => void;
  /** Tool-call observations (best-effort; pulse and claude-code emit, codex may not). */
  onToolCall?: (event: { name: string; args: unknown }) => void;
}

/**
 * Backend-agnostic agent runtime. One instance per teammate.
 *
 * Implementations:
 * - PulseRuntime: in-process pulse-coder-engine (default)
 * - ClaudeCodeRuntime: spawns the `claude` CLI in headless stream-json mode
 * - CodexRuntime: spawns the `codex` CLI (planned)
 */
export interface AgentRuntime {
  readonly kind: AgentRuntimeKind;
  /** Lazy setup (model warmup, child process spawn, etc.). Idempotent. */
  initialize(): Promise<void>;
  /** Run one agent turn and return the final assistant text. */
  run(options: RuntimeRunOptions): Promise<string>;
  /** Optional graceful shutdown (kill child processes, flush state). */
  shutdown?(): Promise<void>;
}

/**
 * Factory: given a runtime context, return a configured runtime.
 * Lets callers parameterise the runtime without leaking constructor shapes.
 */
export type AgentRuntimeFactory = (ctx: RuntimeContext) => AgentRuntime;
