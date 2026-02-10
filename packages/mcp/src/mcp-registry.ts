import { createMCPClient } from '@ai-sdk/mcp';
import type { MCPServerConnection, MCPServerConfig, MCPClient } from './types.js';
import { scanMCPConfig } from './config-scanner.js';

export class MCPRegistry {
  private connections: Map<string, MCPServerConnection> = new Map();
  private initialized = false;

  /**
   * 初始化 MCP Registry
   * @param cwd 工作目录（用于扫描配置文件）
   */
  async initialize(cwd: string): Promise<void> {
    if (this.initialized) {
      console.warn('MCPRegistry already initialized');
      return;
    }

    // 扫描配置文件
    const servers = scanMCPConfig(cwd);

    if (servers.length === 0) {
      console.log('No MCP servers configured');
      this.initialized = true;
      return;
    }

    console.log(`Initializing ${servers.length} MCP server(s)...`);

    // 并行连接所有服务器（使用 Promise.allSettled 避免单个失败影响全局）
    const connectPromises = servers.map(async (serverConfig) => {
      try {
        // 使用 AI SDK 的 createMCPClient (HTTP transport)
        const client = await createMCPClient({
          transport: {
            type: 'http',
            url: serverConfig.url,
            headers: serverConfig.headers,
          },
        });

        // 获取工具（AI SDK 自动转换为 Tool 格式）
        const tools = await client.tools();

        const connection: MCPServerConnection = {
          name: serverConfig.name,
          config: serverConfig,
          client,
          connected: true,
          tools,
        };

        this.connections.set(serverConfig.name, connection);
        console.log(`✓ Connected to MCP server: ${serverConfig.name} (${Object.keys(tools).length} tools)`);
      } catch (error) {
        console.error(`✗ Failed to connect to ${serverConfig.name}:`, error);
        // 记录失败但不抛出异常
        this.connections.set(serverConfig.name, {
          name: serverConfig.name,
          config: serverConfig,
          client: null as any,
          connected: false,
          error: error as Error,
        });
      }
    });

    await Promise.allSettled(connectPromises);
    this.initialized = true;

    const successCount = Array.from(this.connections.values()).filter(c => c.connected).length;
    console.log(`MCP Registry initialized: ${successCount}/${servers.length} servers connected`);
  }

  /**
   * 获取所有工具，并为每个工具添加服务器名称前缀
   */
  getAllTools(): Record<string, any> {
    const allTools: Record<string, any> = {};

    for (const [serverName, connection] of this.connections) {
      if (connection.connected && connection.tools) {
        // 为每个工具添加前缀以避免命名冲突
        for (const [toolName, tool] of Object.entries(connection.tools)) {
          const prefixedName = `mcp_${serverName}_${toolName}`;
          allTools[prefixedName] = tool;
        }
      }
    }

    return allTools;
  }

  /**
   * 获取指定服务器的连接信息
   */
  getConnection(name: string): MCPServerConnection | undefined {
    return this.connections.get(name);
  }

  /**
   * 获取所有连接（包括失败的）
   */
  getAllConnections(): MCPServerConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * 关闭所有 MCP 连接
   */
  async close(): Promise<void> {
    const closePromises = Array.from(this.connections.values())
      .filter(conn => conn.connected && conn.client)
      .map(async (conn) => {
        try {
          await conn.client.close();
          console.log(`Closed MCP server: ${conn.name}`);
        } catch (error) {
          console.error(`Failed to close ${conn.name}:`, error);
        }
      });

    await Promise.allSettled(closePromises);
    this.connections.clear();
    this.initialized = false;
  }
}
