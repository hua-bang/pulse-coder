import type { EventEmitter } from 'events';
import type { ModelMessage } from 'ai';

import type { Context, SystemPromptOption } from '../shared/types.js';

// ---------------------------------------------------------------------------
// Hook input / result types
// ---------------------------------------------------------------------------

/** Convenience: a value that may be wrapped in a Promise. */
export type Promisable<T> = T | Promise<T>;

// -- beforeRun / beforeLLMCall share the same shape --

export interface BeforeRunInput {
  context: Context;
  systemPrompt?: SystemPromptOption;
  tools: Record<string, any>;
}

export interface BeforeRunResult {
  systemPrompt?: SystemPromptOption;
  tools?: Record<string, any>;
}

export type BeforeLLMCallInput = BeforeRunInput;
export type BeforeLLMCallResult = BeforeRunResult;

// -- afterRun --

export interface AfterRunInput {
  context: Context;
  result: string;
}

// -- afterLLMCall --

export interface AfterLLMCallInput {
  context: Context;
  finishReason: string;
  text: string;
}

// -- beforeToolCall --

export interface BeforeToolCallInput {
  name: string;
  input: any;
}

export interface BeforeToolCallResult {
  input?: any;
}

// -- afterToolCall --

export interface AfterToolCallInput {
  name: string;
  input: any;
  output: any;
}

export interface AfterToolCallResult {
  output?: any;
}

// -- onCompacted --

export interface OnCompactedEvent {
  attempt: number;
  trigger: 'pre-loop' | 'length-retry';
  reason?: string;
  forced: boolean;
  beforeMessageCount: number;
  afterMessageCount: number;
  beforeEstimatedTokens: number;
  afterEstimatedTokens: number;
  strategy: 'summary' | 'summary-too-large' | 'fallback';
}

export interface OnCompactedInput {
  context: Context;
  event: OnCompactedEvent;
  previousMessages: ModelMessage[];
  newMessages: ModelMessage[];
}

// ---------------------------------------------------------------------------
// Hook map - the definitive list of engine hooks and their signatures
// ---------------------------------------------------------------------------

export interface EngineHookMap {
  /** Fires once at the start of Engine.run(), before entering the loop. */
  beforeRun: (input: BeforeRunInput) => Promisable<BeforeRunResult | void>;

  /** Fires once when Engine.run() finishes. Read-only. */
  afterRun: (input: AfterRunInput) => Promisable<void>;

  /** Fires before each LLM call inside the loop (including retries after tool-calls). */
  beforeLLMCall: (input: BeforeLLMCallInput) => Promisable<BeforeLLMCallResult | void>;

  /** Fires after each LLM call completes. Read-only. */
  afterLLMCall: (input: AfterLLMCallInput) => Promisable<void>;

  /** Fires before each individual tool execution. Can modify input or throw to abort. */
  beforeToolCall: (input: BeforeToolCallInput) => Promisable<BeforeToolCallResult | void>;

  /** Fires after each individual tool execution. Can modify output. */
  afterToolCall: (input: AfterToolCallInput) => Promisable<AfterToolCallResult | void>;

  /** Fires after context compaction produced a new message list. */
  onCompacted: (input: OnCompactedInput) => Promisable<void>;
}

export type EngineHookName = keyof EngineHookMap;

// ---------------------------------------------------------------------------
// Plugin interface
// ---------------------------------------------------------------------------

export interface EnginePlugin {
  name: string;
  version: string;
  dependencies?: string[];

  beforeInitialize?(context: EnginePluginContext): Promise<void>;
  initialize(context: EnginePluginContext): Promise<void>;
  afterInitialize?(context: EnginePluginContext): Promise<void>;

  destroy?(context: EnginePluginContext): Promise<void>;
}

// ---------------------------------------------------------------------------
// Plugin context - passed to every plugin during its lifecycle
// ---------------------------------------------------------------------------

export interface EnginePluginContext {
  // Tool registration
  registerTool(name: string, tool: any): void;
  registerTools(tools: Record<string, any>): void;
  getTool(name: string): any;
  /** Returns a snapshot of all tools registered by plugins so far. */
  getTools(): Record<string, any>;

  // Hook registration (replaces the old registerRunHook)
  registerHook<K extends EngineHookName>(hookName: K, handler: EngineHookMap[K]): void;

  // Service registration
  registerService<T>(name: string, service: T): void;
  getService<T>(name: string): T | undefined;

  // Configuration
  getConfig<T>(key: string): T | undefined;
  setConfig<T>(key: string, value: T): void;

  // Event system
  events: EventEmitter;

  // Logger
  logger: {
    debug(message: string, meta?: any): void;
    info(message: string, meta?: any): void;
    warn(message: string, meta?: any): void;
    error(message: string, error?: Error, meta?: any): void;
  };
}

// ---------------------------------------------------------------------------
// Plugin loading options
// ---------------------------------------------------------------------------

export interface EnginePluginLoadOptions {
  plugins?: EnginePlugin[];
  dirs?: string[];
  scan?: boolean;
}

export const DEFAULT_ENGINE_PLUGIN_DIRS = [
  '.pulse-coder/engine-plugins',
  '.coder/engine-plugins',
  '~/.pulse-coder/engine-plugins',
  '~/.coder/engine-plugins',
  './plugins/engine'
];
