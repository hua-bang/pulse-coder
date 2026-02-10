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