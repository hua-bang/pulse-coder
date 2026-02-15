import type { FlexibleSchema, ModelMessage, LanguageModel } from "ai";

/**
 * Custom LLM provider factory - receives a model name and returns a LanguageModel.
 * Use this to plug in any Vercel AI SDK-compatible provider.
 *
 * @example
 * import { createOpenAI } from '@ai-sdk/openai';
 * const provider: LLMProviderFactory = createOpenAI({ apiKey: '...' }).chat;
 *
 * @example
 * import { createAnthropic } from '@ai-sdk/anthropic';
 * const provider: LLMProviderFactory = createAnthropic({ apiKey: '...' });
 */
export type LLMProviderFactory = (model: string) => LanguageModel;

/**
 * System prompt customization.
 * - `string` — replaces the built-in prompt entirely.
 * - `() => string` — factory evaluated on every request (supports dynamic prompts).
 * - `{ append: string }` — appends extra content after the built-in prompt.
 */
export type SystemPromptOption =
  | string
  | (() => string)
  | { append: string };

/**
 * Hooks that fire around every tool execution.
 *
 * @example
 * const hooks: ToolHooks = {
 *   onBeforeToolCall: (name, input) => {
 *     if (name === 'bash') throw new Error('bash tool is disabled');
 *     return input; // can return modified input
 *   },
 *   onAfterToolCall: (name, input, output) => {
 *     auditLog(name, input, output);
 *     return output; // can return modified output
 *   },
 * };
 */
export interface ToolHooks {
  /**
   * Called before a tool executes.
   * Return a (possibly modified) input object, or throw to abort the call.
   */
  onBeforeToolCall?: (name: string, input: any) => any | Promise<any>;
  /**
   * Called after a tool executes.
   * Return a (possibly modified) output value.
   */
  onAfterToolCall?: (name: string, input: any, output: any) => any | Promise<any>;
}

export interface ClarificationRequest {
  id: string;
  question: string;
  context?: string;
  defaultAnswer?: string;
  timeout: number;
}

export interface ToolExecutionContext {
  onClarificationRequest?: (request: ClarificationRequest) => Promise<string>;
  abortSignal?: AbortSignal;
}

export interface Tool<Input = any, Output = any> {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<Input>;
  execute: (input: Input, context?: ToolExecutionContext) => Promise<Output>;
}

export interface Context {
  messages: ModelMessage[];
}

export interface IPlugin {
  name: string;
  version: string;
  extensions: Extension[];
  activate(context: IExtensionContext): Promise<void>;
  deactivate?(): Promise<void>;
}

export interface Extension {
  type: 'skill' | 'mcp' | 'tool' | 'context';
  provider: any;
}

export interface IExtensionContext {
  registerTools(toolName: string, tool: Tool<any, any>): void;
  logger: ILogger;
}

export interface ILogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
}