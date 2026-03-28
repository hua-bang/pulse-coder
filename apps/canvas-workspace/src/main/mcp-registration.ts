import { execFile } from 'child_process';
import { promisify } from 'util';
import { MCP_PORT } from './mcp-server';

const execFileAsync = promisify(execFile);

const SERVER_NAME = 'canvas-workspace';
const SERVER_URL = `http://localhost:${MCP_PORT}/mcp`;

async function ensureClaudeCodeRegistered(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('claude', ['mcp', 'get', SERVER_NAME]);
    if (stdout.includes(SERVER_NAME)) return;
  } catch {
    // not registered or claude not installed
  }
  try {
    await execFileAsync('claude', ['mcp', 'add', '--transport', 'http', SERVER_NAME, SERVER_URL]);
    console.log('[MCP] Registered with Claude Code');
  } catch {
    // claude not installed — skip silently
  }
}

async function ensureCodexRegistered(): Promise<void> {
  try {
    const { stdout } = await execFileAsync('codex', ['mcp', 'list']);
    if (stdout.includes(SERVER_NAME)) return;
  } catch {
    // not registered or codex not installed
  }
  try {
    await execFileAsync('codex', ['mcp', 'add', SERVER_NAME, '--url', SERVER_URL]);
    console.log('[MCP] Registered with Codex');
  } catch {
    // codex not installed — skip silently
  }
}

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
