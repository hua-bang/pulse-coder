import type { EnginePlugin, EnginePluginContext } from '@coder/engine';
import { MCPRegistry } from './mcp-registry.js';

export const mcpRegistryPlugin: EnginePlugin = {
  name: '@coder/mcp/mcp-registry',
  version: '1.0.0',

  async initialize(context: EnginePluginContext) {
    // 初始化 MCP 注册表（自己扫描配置文件）
    const registry = new MCPRegistry();
    await registry.initialize(process.cwd());

    // 获取所有 MCP 工具（已经是 AI SDK Tool 格式，无需转换）
    const tools = registry.getAllTools();
    const toolCount = Object.keys(tools).length;

    // 批量注册工具
    if (toolCount > 0) {
      context.registerTools(tools);
    }

    // 注册 registry 为服务供其他插件使用
    context.registerService('mcpRegistry', registry);

    const connectedServers = registry.getAllConnections().filter(c => c.connected).length;
    context.logger?.info?.(`MCP Plugin: Registered ${toolCount} tool(s) from ${connectedServers} server(s)`);
  },

  async destroy(context: EnginePluginContext) {
    const registry = context.getService<MCPRegistry>('mcpRegistry');
    if (registry) {
      await registry.close();
      context.logger?.info?.('MCP Plugin: Closed all connections');
    }
  }
};
