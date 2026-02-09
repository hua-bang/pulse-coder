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

// ========== Plugin System ==========

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

export interface IPlugin {
  name: string;
  version: string;
  activate(context: IPluginContext): Promise<void>;
  deactivate?(): Promise<void>;
}

export interface IPluginContext {
  registerTool(tool: Tool): void;
  registerTools(tools: Tool[]): void;
  registerPrompt(prompt: PromptSegment): void;
  registerSkill(skill: SkillInfo): void;
  registerSkills(skills: SkillInfo[]): void;
  registerMCP(config: MCPServerConfig): void;
  logger: ILogger;
}

export interface ILogger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, error?: Error, meta?: Record<string, unknown>): void;
}
