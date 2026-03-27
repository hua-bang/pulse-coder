import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { MCP_PORT } from './mcp-server';

const SERVER_NAME = 'canvas-workspace';
const SERVER_URL = `http://localhost:${MCP_PORT}/mcp`;

/**
 * Write canvas-workspace MCP server entry into ~/.claude/settings.json.
 * Merges with existing settings; no-ops if already registered.
 */
async function ensureClaudeCodeRegistered(): Promise<void> {
  const settingsPath = join(homedir(), '.claude', 'settings.json');
  try {
    let settings: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // file missing or invalid JSON — start fresh
    }

    const servers = (settings.mcpServers ?? {}) as Record<string, unknown>;
    if (servers[SERVER_NAME]) return; // already present

    servers[SERVER_NAME] = { url: SERVER_URL };
    settings.mcpServers = servers;

    await fs.mkdir(join(homedir(), '.claude'), { recursive: true });
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf-8');
    console.log('[MCP] Registered with Claude Code (~/.claude/settings.json)');
  } catch (err) {
    console.warn('[MCP] Could not register with Claude Code:', err);
  }
}

/**
 * Append canvas-workspace MCP server entry into ~/.codex/config.toml.
 * No-ops if already registered.
 */
async function ensureCodexRegistered(): Promise<void> {
  const configPath = join(homedir(), '.codex', 'config.toml');
  const marker = `[mcp_servers.${SERVER_NAME}]`;
  try {
    let config = '';
    try {
      config = await fs.readFile(configPath, 'utf-8');
    } catch {
      // file missing — will be created
    }

    if (config.includes(marker)) return; // already present

    const entry = `\n${marker}\nurl = "${SERVER_URL}"\nenabled = true\n`;
    await fs.mkdir(join(homedir(), '.codex'), { recursive: true });
    await fs.writeFile(configPath, config + entry, 'utf-8');
    console.log('[MCP] Registered with Codex (~/.codex/config.toml)');
  } catch (err) {
    console.warn('[MCP] Could not register with Codex:', err);
  }
}

/**
 * Ensure canvas-workspace MCP server is registered with both
 * Claude Code and Codex. Runs at app startup; safe to call repeatedly.
 */
export async function ensureMCPRegistered(): Promise<void> {
  await Promise.allSettled([
    ensureClaudeCodeRegistered(),
    ensureCodexRegistered()
  ]);
}
