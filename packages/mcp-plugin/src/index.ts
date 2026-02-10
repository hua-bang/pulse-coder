import { EnginePlugin, EnginePluginContext } from '@coder/engine';
import { createMCPClient } from '@ai-sdk/mcp';
import { loadMCPConfig } from './config-loader';
import { createHTTPTransport } from './transport';

export const mcpPlugin: EnginePlugin = {
  name: '@coder/mcp-plugin',
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
            tool as any // Type assertion to handle Tool type mismatch
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

export default mcpPlugin;