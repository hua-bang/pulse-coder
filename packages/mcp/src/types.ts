// MCPClient 类型由 AI SDK 提供（导入实际类型以避免类型不兼容）
import type { MCPClient as AI_MCPClient } from '@ai-sdk/mcp';

export type MCPClient = AI_MCPClient;

// MCP 服务器配置（在 mcp 包中定义，不依赖 engine）
// 目前仅支持 HTTP Transport
export interface MCPServerConfig {
  name: string;
  url: string;  // HTTP URL of the MCP server
  headers?: Record<string, string>;  // Optional HTTP headers (e.g., Authorization)
  description?: string;
  enabled?: boolean;
}

// MCP 配置文件格式
export interface MCPConfigFile {
  servers: MCPServerConfig[];
  version?: string;
}

export interface MCPServerConnection {
  name: string;
  config: MCPServerConfig;
  client: MCPClient;
  connected: boolean;
  tools?: Record<string, any>;
  error?: Error;
}
