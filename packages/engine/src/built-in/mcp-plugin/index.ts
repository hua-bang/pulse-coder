/**
 * Built-in MCP Plugin for Pulse Coder Engine
 * 将 MCP 功能作为引擎内置插件
 */

import { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import { createMCPClient, type MCPClientConfig } from '@ai-sdk/mcp';
import { Experimental_StdioMCPTransport } from '@ai-sdk/mcp/mcp-stdio';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

type RawMCPServerConfig = Record<string, unknown>;

interface HTTPOrSSEServerConfig {
  transport: 'http' | 'sse';
  url: string;
  headers?: Record<string, string>;
}

interface StdioServerConfig {
  transport: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

type NormalizedMCPServerConfig = HTTPOrSSEServerConfig | StdioServerConfig;

export interface MCPPluginConfig {
  servers: Record<string, RawMCPServerConfig>;
}

export async function loadMCPConfig(cwd: string): Promise<MCPPluginConfig> {
  // 优先读取 .pulse-coder/mcp.json，兼容旧版 .coder/mcp.json
  const newConfigPath = path.join(cwd, '.pulse-coder', 'mcp.json');
  const legacyConfigPath = path.join(cwd, '.coder', 'mcp.json');
  const configPath = existsSync(newConfigPath) ? newConfigPath : legacyConfigPath;

  if (!existsSync(configPath)) {
    return { servers: {} };
  }

  try {
    const content = readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(content);

    if (!parsed.servers || typeof parsed.servers !== 'object') {
      console.warn('[MCP] Invalid config: missing "servers" object');
      return { servers: {} };
    }

    return { servers: parsed.servers as Record<string, RawMCPServerConfig> };
  } catch (error) {
    console.warn(`[MCP] Failed to load config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return { servers: {} };
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  return Object.values(value).every(item => typeof item === 'string');
}

function normalizeServerConfig(serverName: string, raw: RawMCPServerConfig): NormalizedMCPServerConfig | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    console.warn(`[MCP] Server "${serverName}" config must be an object, skipping`);
    return null;
  }

  const transport = typeof raw.transport === 'string' ? raw.transport.toLowerCase() : 'http';

  if (transport === 'http' || transport === 'sse') {
    if (typeof raw.url !== 'string' || !raw.url.trim()) {
      console.warn(`[MCP] Server "${serverName}" missing URL for ${transport} transport, skipping`);
      return null;
    }

    const normalized: HTTPOrSSEServerConfig = {
      transport,
      url: raw.url
    };

    if (raw.headers !== undefined) {
      if (!isStringRecord(raw.headers)) {
        console.warn(`[MCP] Server "${serverName}" has invalid headers; expected string map, ignoring headers`);
      } else {
        normalized.headers = raw.headers;
      }
    }

    return normalized;
  }

  if (transport === 'stdio') {
    if (typeof raw.command !== 'string' || !raw.command.trim()) {
      console.warn(`[MCP] Server "${serverName}" missing command for stdio transport, skipping`);
      return null;
    }

    const normalized: StdioServerConfig = {
      transport: 'stdio',
      command: raw.command
    };

    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || !raw.args.every(arg => typeof arg === 'string')) {
        console.warn(`[MCP] Server "${serverName}" has invalid args; expected string array, ignoring args`);
      } else {
        normalized.args = raw.args;
      }
    }

    if (raw.env !== undefined) {
      if (!isStringRecord(raw.env)) {
        console.warn(`[MCP] Server "${serverName}" has invalid env; expected string map, ignoring env`);
      } else {
        normalized.env = raw.env;
      }
    }

    if (raw.cwd !== undefined) {
      if (typeof raw.cwd !== 'string' || !raw.cwd.trim()) {
        console.warn(`[MCP] Server "${serverName}" has invalid cwd; expected non-empty string, ignoring cwd`);
      } else {
        normalized.cwd = raw.cwd;
      }
    }

    return normalized;
  }

  console.warn(`[MCP] Server "${serverName}" has unsupported transport "${transport}", skipping`);
  return null;
}

function createTransport(config: NormalizedMCPServerConfig): MCPClientConfig['transport'] {
  if (config.transport === 'stdio') {
    return new Experimental_StdioMCPTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd
    });
  }

  return {
    type: config.transport,
    url: config.url,
    headers: config.headers
  };
}

export const builtInMCPPlugin: EnginePlugin = {
  name: 'pulse-coder-engine/built-in-mcp',
  version: '1.1.0',

  async initialize(context: EnginePluginContext) {
    const config = await loadMCPConfig(process.cwd());

    const serverCount = Object.keys(config.servers).length;
    if (serverCount === 0) {
      console.log('[MCP] No MCP servers configured');
      return;
    }

    let loadedCount = 0;

    for (const [serverName, rawServerConfig] of Object.entries(config.servers)) {
      try {
        const normalizedConfig = normalizeServerConfig(serverName, rawServerConfig);
        if (!normalizedConfig) {
          continue;
        }

        const transport = createTransport(normalizedConfig);
        const client = await createMCPClient({ transport });

        const tools = await client.tools();

        // 注册工具到引擎，使用命名空间前缀
        const namespacedTools = Object.fromEntries(
          Object.entries(tools).map(([toolName, tool]) => [
            `mcp_${serverName}_${toolName}`,
            tool as any
          ])
        );

        context.registerTools(namespacedTools);

        loadedCount++;
        console.log(`[MCP] Server "${serverName}" loaded (${Object.keys(tools).length} tools)`);

        // 注册服务供其他插件使用
        context.registerService(`mcp:${serverName}`, client);

      } catch (error) {
        console.warn(`[MCP] Failed to load server "${serverName}": ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

    if (loadedCount > 0) {
      console.log(`[MCP] Successfully loaded ${loadedCount}/${serverCount} MCP servers`);
    } else {
      console.warn('[MCP] No MCP servers were loaded successfully');
    }
  }
};

export default builtInMCPPlugin;
