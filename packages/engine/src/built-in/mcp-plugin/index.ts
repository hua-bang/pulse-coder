/**
 * Built-in MCP Plugin for Coder Engine
 * 将 MCP 功能作为引擎内置插件
 */

import { EnginePlugin, EnginePluginContext } from '../../plugin/EnginePlugin';
import { createMCPClient } from '@ai-sdk/mcp';
import { existsSync, readFileSync } from 'fs';
import * as path from 'path';

export interface MCPPluginConfig {
  servers: Record<string, { url: string }>;
}

export async function loadMCPConfig(cwd: string): Promise<MCPPluginConfig> {
  const configPath = path.join(cwd, '.coder', 'mcp.json');
  
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

    return { servers: parsed.servers };
  } catch (error) {
    console.warn(`[MCP] Failed to load config: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return { servers: {} };
  }
}

function createHTTPTransport(config: { url: string }) {
  return {
    type: 'http' as const,
    url: config.url
  };
}

export const builtInMCPPlugin: EnginePlugin = {
  name: '@coder/engine/built-in-mcp',
  version: '1.0.0',

  async initialize(context: EnginePluginContext) {
    const config = await loadMCPConfig(process.cwd());

    const serverCount = Object.keys(config.servers).length;
    if (serverCount === 0) {
      console.log('[MCP] No MCP servers configured');
      return;
    }

    let loadedCount = 0;

    for (const [serverName, serverConfig] of Object.entries(config.servers)) {
      try {
        if (!serverConfig.url) {
          console.warn(`[MCP] Server "${serverName}" missing URL, skipping`);
          continue;
        }

        const transport = createHTTPTransport(serverConfig);
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