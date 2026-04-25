import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox } from '../mailbox.js';
import { TaskList } from '../task-list.js';
import { ClaudeCodeRuntime } from '../runtimes/claude-code-runtime.js';
import type { RuntimeContext } from '../runtimes/types.js';

/**
 * Build a tiny shell script that mimics `claude -p ... --output-format stream-json`
 * by echoing pre-canned NDJSON lines, and return its absolute path.
 */
function writeFakeClaudeCli(dir: string, lines: string[]): string {
  const script = join(dir, 'fake-claude.sh');
  const body = ['#!/usr/bin/env bash', 'set -e'];
  for (const line of lines) {
    // single-quote-safe echo
    const escaped = line.replace(/'/g, `'\\''`);
    body.push(`printf '%s\\n' '${escaped}'`);
  }
  writeFileSync(script, body.join('\n') + '\n', 'utf-8');
  chmodSync(script, 0o755);
  return script;
}

function makeCtx(stateDir: string): RuntimeContext {
  return {
    teammateId: 'agent-1',
    teammateName: 'researcher',
    cwd: stateDir,
    mailbox: new Mailbox(stateDir),
    taskList: new TaskList(stateDir),
    stateDir,
    requirePlanApproval: false,
  };
}

describe('ClaudeCodeRuntime', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'claude-runtime-'));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it('streams text and reports the final result', async () => {
    const cli = writeFakeClaudeCli(workDir, [
      JSON.stringify({ type: 'system', session_id: 's-1' }),
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'hello ' },
            { type: 'text', text: 'world' },
            { type: 'tool_use', name: 'team_send_message', input: { to: 'b', content: 'hi' } },
          ],
        },
      }),
      JSON.stringify({ type: 'result', result: 'hello world' }),
    ]);

    const ctx = makeCtx(workDir);
    const runtime = new ClaudeCodeRuntime(ctx, {
      cliPath: cli,
      // Avoid resolving the not-yet-built mailbox-mcp-server.js
      mcpServerEntry: join(workDir, 'fake-mcp.js'),
    });
    await runtime.initialize();

    const chunks: string[] = [];
    const tools: Array<{ name: string; args: unknown }> = [];
    const result = await runtime.run({
      prompt: 'do thing',
      systemPrompt: 'you are a tester',
      abortSignal: new AbortController().signal,
      onText: (delta) => chunks.push(delta),
      onToolCall: (e) => tools.push(e),
    });

    expect(chunks).toEqual(['hello ', 'world']);
    expect(tools).toEqual([
      { name: 'team_send_message', args: { to: 'b', content: 'hi' } },
    ]);
    expect(result).toBe('hello world');
  });

  it('captures session_id for resume on subsequent runs', async () => {
    const cli = writeFakeClaudeCli(workDir, [
      JSON.stringify({ type: 'system', session_id: 'sess-xyz' }),
      JSON.stringify({ type: 'result', result: 'ok' }),
    ]);
    const ctx = makeCtx(workDir);
    const runtime = new ClaudeCodeRuntime(ctx, {
      cliPath: cli,
      mcpServerEntry: join(workDir, 'fake-mcp.js'),
    });
    await runtime.initialize();
    await runtime.run({
      prompt: 'p',
      systemPrompt: 's',
      abortSignal: new AbortController().signal,
    });
    // Session id is private; verify by introspecting via `(runtime as any)` for now.
    expect((runtime as any).sessionId).toBe('sess-xyz');
  });

  it('writes the per-teammate MCP config on initialize()', async () => {
    const ctx = makeCtx(workDir);
    const runtime = new ClaudeCodeRuntime(ctx, {
      cliPath: '/bin/true',
      mcpServerEntry: '/tmp/fake-mcp.js',
    });
    await runtime.initialize();
    const cfgPath = join(workDir, 'runtime', 'agent-1', 'mcp-config.json');
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    expect(cfg.mcpServers.mailbox.env.PULSE_TEAMMATE_ID).toBe('agent-1');
    expect(cfg.mcpServers.mailbox.env.PULSE_TEAM_STATE_DIR).toBe(workDir);
  });
});
