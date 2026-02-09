import type { FlexibleSchema, ModelMessage } from "ai";

// ========== Tool ==========

export interface Tool<Input = any, Output = any> {
  name: string;
  description: string;
  inputSchema: FlexibleSchema<Input>;
  execute: (input: Input) => Promise<Output>;
}

// ========== Context ==========

export interface Context {
  messages: ModelMessage[];
}

// ========== Shared Data Types ==========

export interface SkillInfo {
  name: string;
  description: string;
  content: string;
  location?: string;
  metadata?: Record<string, any>;
}

export interface PromptSegment {
  name: string;
  content: string;
  priority?: number;
}

export interface MCPServerConfig {
  name: string;
  transport: 'stdio' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env?: Record<string, string>;
}

// ========== Provider (Resource Layer) ==========
// Providers are simple, declarative resource registrations.
// External users register providers to supply data that plugins consume.

export interface IProvider {
  name: string;
  type: string;
}

export interface ToolProvider extends IProvider {
  type: 'tool';
  tools: Tool[];
}

export interface PromptProvider extends IProvider {
  type: 'prompt';
  prompts: PromptSegment[];
}

export interface SkillProvider extends IProvider {
  type: 'skill';
  skills: SkillInfo[];
}

export interface MCPProvider extends IProvider {
  type: 'mcp';
  servers: MCPServerConfig[];
}

export type Provider = ToolProvider | PromptProvider | SkillProvider | MCPProvider;

// ========== Plugin (Mechanism Layer) ==========
// Plugins implement AI mechanisms (skill system, MCP protocol, subagent, etc.).
// They consume providers via getProviders() and register tools/prompts into the engine.

export interface IPlugin {
  name: string;
  version: string;
  activate(context: IPluginContext): Promise<void>;
  deactivate?(): Promise<void>;
}

export interface IPluginContext {
  registerTool(tool: Tool): void;
  registerPrompt(prompt: PromptSegment): void;
  getProviders<T extends IProvider>(type: string): T[];
  logger: ILogger;
}

// ========== Logger ==========

export interface ILogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
}
