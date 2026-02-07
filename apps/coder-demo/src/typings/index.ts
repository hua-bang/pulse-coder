import type { FlexibleSchema, ModelMessage } from "ai";

export interface Tool<Input = any, Output = any> {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<Input>;
  execute: (input: Input) => Promise<Output>;
}

export interface Context {
  messages: ModelMessage[];
  /** Abort signal to cancel the loop externally */
  abortSignal?: AbortSignal;
}

/** Information about a single tool invocation within a turn */
export interface ToolCallInfo {
  toolCallId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string;
  durationMs: number;
}

/** Snapshot of a single agent turn */
export interface TurnInfo {
  /** 1-based turn index */
  index: number;
  /** Tool calls executed in this turn */
  toolCalls: ToolCallInfo[];
  /** Whether the AI produced a text response */
  hasText: boolean;
  /** Duration of the entire turn in ms */
  durationMs: number;
}

/** Final result returned by the agent loop */
export interface LoopResult {
  /** Final text response from the agent */
  text: string;
  /** All turns executed */
  turns: TurnInfo[];
  /** Why the loop finished */
  finishReason: 'complete' | 'max_turns' | 'max_errors' | 'aborted';
  /** Total duration in ms */
  totalDurationMs: number;
}

/** Lifecycle hooks for the agent loop */
export interface LoopHooks {
  /** Called at the start of each turn */
  onTurnStart?: (turn: { index: number }) => void;
  /** Called at the end of each turn */
  onTurnEnd?: (turn: TurnInfo) => void;
  /** Called before each tool is executed */
  onToolCallStart?: (info: { toolCallId: string; toolName: string; input: unknown }) => void;
  /** Called after each tool finishes */
  onToolCallEnd?: (info: ToolCallInfo) => void;
  /** Called when the AI produces a text response (per-step) */
  onText?: (text: string) => void;
  /** Called when an error occurs */
  onError?: (error: Error, turn: { index: number }) => void;
}

export interface LoopOptions {
  /** Maximum number of turns before stopping */
  maxTurns?: number;
  /** Maximum consecutive errors before stopping */
  maxErrors?: number;
  /** Lifecycle hooks */
  hooks?: LoopHooks;
}
