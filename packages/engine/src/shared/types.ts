import type { FlexibleSchema, ModelMessage } from "ai";

export interface Tool<Input = any, Output = any> {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<Input>;
  execute: (input: Input) => Promise<Output>;
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