import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { homedir } from 'os';
import type { MCPServerConfig, MCPConfigFile } from './types.js';

/**
 * 扫描并加载 MCP 服务器配置
 * 扫描路径优先级：
 * 1. 项目级别：.coder/mcp-servers.json
 * 2. 用户级别：~/.coder/mcp-servers.json
 */
export function scanMCPConfig(cwd: string): MCPServerConfig[] {
  const servers: MCPServerConfig[] = [];

  const scanPaths = [
    resolve(cwd, '.coder/mcp-servers.json'),      // 项目级配置
    resolve(homedir(), '.coder/mcp-servers.json'), // 用户级配置
  ];

  for (const configPath of scanPaths) {
    try {
      if (!existsSync(configPath)) {
        continue;
      }

      const content = readFileSync(configPath, 'utf-8');
      const config: MCPConfigFile = JSON.parse(content);

      if (!config.servers || !Array.isArray(config.servers)) {
        console.warn(`Invalid MCP config file: ${configPath}`);
        continue;
      }

      // 过滤启用的服务器
      const enabledServers = config.servers.filter(
        server => server.enabled !== false
      );

      servers.push(...enabledServers);
      console.log(`Loaded ${enabledServers.length} MCP server(s) from ${configPath}`);
    } catch (error) {
      console.warn(`Failed to load MCP config from ${configPath}:`, error);
    }
  }

  return servers;
}
