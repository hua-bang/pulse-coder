import { execFile } from 'child_process';
import { promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { promisify } from 'util';
import { MCP_PORT } from './mcp-server';

const execFileAsync = promisify(execFile);

const SERVER_NAME = 'canvas-workspace';
const SERVER_URL = `http://localhost:${MCP_PORT}/mcp`;

// ---------------------------------------------------------------------------
// Claude Code
// MCP servers live in ~/.claude.json under the "mcpServers" key (user scope).
// We prefer the CLI (`claude mcp add`) and fall back to direct file write.
// Format: { "type": "http", "url": "..." }
// ---------------------------------------------------------------------------

async function isClaudeRegistered(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('claude', ['mcp', 'get', SERVER_NAME]);
    return stdout.includes(SERVER_NAME);
  } catch {
    return false;
  }
}

async function registerClaudeCLI(): Promise<boolean> {
  try {
    await execFileAsync('claude', [
      'mcp', 'add',
      '--transport', 'http',
      SERVER_NAME,
      SERVER_URL,
    ]);
    console.log('[MCP] Registered with Claude Code (via CLI)');
    return true;
  } catch {
    return false;
  }
}

async function registerClaudeFile(): Promise<void> {
  // User-scope config: ~/.claude.json
  const filePath = join(homedir(), '.claude.json');
  try {
    let config: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(filePath, 'utf-8');
      config = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      // file missing or invalid — start fresh
    }

    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    if (servers[SERVER_NAME]) return; // already present

    servers[SERVER_NAME] = { type: 'http', url: SERVER_URL };
    config.mcpServers = servers;

    await fs.writeFile(filePath, JSON.stringify(config, null, 2), 'utf-8');
    console.log('[MCP] Registered with Claude Code (~/.claude.json)');
  } catch (err) {
    console.warn('[MCP] Could not register with Claude Code via file:', err);
  }
}

async function ensureClaudeCodeRegistered(): Promise<void> {
  if (await isClaudeRegistered()) return;
  const ok = await registerClaudeCLI();
  if (!ok) await registerClaudeFile();
}

// ---------------------------------------------------------------------------
// Codex
// Config: ~/.codex/config.toml  (TOML format)
// HTTP servers use `url = "..."` under [mcp_servers.<name>].
// CLI only supports stdio; we write the TOML directly.
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------

/**
 * Ensure canvas-workspace MCP server is registered with both
 * Claude Code and Codex. Runs at app startup; safe to call repeatedly.
 */
export async function ensureMCPRegistered(): Promise<void> {
  await Promise.allSettled([
    ensureClaudeCodeRegistered(),
    ensureCodexRegistered(),
  ]);
}
