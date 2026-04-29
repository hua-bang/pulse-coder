import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createCli } from '../../cli';
import { _resetTeamCache } from '../../core/team';

/**
 * Integration tests for `pulse-canvas team ...` subcommands.
 *
 * We invoke the commander program in-process via `createCli().parseAsync`
 * so we exercise the full args → handler → core → file IO path that an
 * agent would hit when shelling out to the binary. Console output is
 * captured per-test so we can assert on stdout / exit codes without the
 * test runner output getting polluted.
 *
 * State is isolated per-test by pointing PULSE_TEAMS_ROOT at a fresh
 * tmpdir, plus calling `_resetTeamCache()` between runs (the runtime
 * cache lives in module scope and would otherwise leak across tests).
 */

let teamsRoot: string;
let archiveRoot: string;
let stdoutLines: string[];
let stderrLines: string[];
let originalConsoleLog: typeof console.log;
let originalConsoleError: typeof console.error;
let originalExit: typeof process.exit;

beforeEach(async () => {
  teamsRoot = join(tmpdir(), `team-cli-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  archiveRoot = `${teamsRoot}-archive`;
  process.env.PULSE_TEAMS_ROOT = teamsRoot;
  process.env.PULSE_TEAMS_ARCHIVE_ROOT = archiveRoot;
  await fs.mkdir(teamsRoot, { recursive: true });

  _resetTeamCache();

  // The output helper writes via console.log / console.error, which
  // vitest intercepts at a higher level than process.stdout.write — so
  // monkey-patching the underlying writes wouldn't capture anything.
  // Patch the console methods directly instead.
  stdoutLines = [];
  stderrLines = [];
  originalConsoleLog = console.log;
  originalConsoleError = console.error;
  console.log = (...args: unknown[]) => {
    stdoutLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };
  console.error = (...args: unknown[]) => {
    stderrLines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
  };

  // errorOutput() calls process.exit(1). In tests we'd rather throw a
  // typed sentinel so individual test cases can `expect(...).rejects`.
  originalExit = process.exit;
  process.exit = ((code?: number) => {
    throw new ExitCalled(code ?? 0);
  }) as typeof process.exit;
});

afterEach(async () => {
  console.log = originalConsoleLog;
  console.error = originalConsoleError;
  process.exit = originalExit;
  delete process.env.PULSE_TEAMS_ROOT;
  delete process.env.PULSE_TEAMS_ARCHIVE_ROOT;
  await fs.rm(teamsRoot, { recursive: true, force: true });
  await fs.rm(archiveRoot, { recursive: true, force: true });
});

class ExitCalled extends Error {
  constructor(public code: number) {
    super(`process.exit(${code})`);
  }
}

/** Run the CLI with `argv` (excluding the leading "node binary" pair).
 *  Returns the captured stdout/stderr; throws ExitCalled on errorOutput. */
async function runCli(argv: string[]): Promise<{ stdout: string; stderr: string }> {
  // commander's parseAsync expects the full argv shape (binary, script, ...).
  // The actual values for the leading two slots don't matter to commander.
  await createCli().parseAsync(['node', 'pulse-canvas', ...argv]);
  return { stdout: stdoutLines.join('\n'), stderr: stderrLines.join('\n') };
}

/** Convenience: run with --format json and parse the captured stdout
 *  as a single JSON value. The `output` helper makes one console.log
 *  call per command, so stdoutLines[0] is exactly that JSON document. */
async function runJson<T = unknown>(argv: string[]): Promise<T> {
  await runCli([...argv, '--format', 'json']);
  if (stdoutLines.length === 0) {
    throw new Error(`runJson: no stdout captured for ${argv.join(' ')}`);
  }
  // Pick the LAST line — every test invocation runs in a fresh stdout
  // buffer (cleared in beforeEach), but if a single test calls runJson
  // multiple times the buffer accumulates, so the most recent log is
  // what the caller wants.
  return JSON.parse(stdoutLines[stdoutLines.length - 1]) as T;
}

describe('pulse-canvas team', () => {
  describe('create + list + status', () => {
    it('creates a team with a valid uuid and persists config.json', async () => {
      const created = await runJson<{ teamId: string; teamName: string; stateDir: string }>([
        '--workspace', 'ws-1', 'team', 'create', 'My Team',
      ]);
      expect(created.teamName).toBe('My Team');
      expect(created.teamId).toMatch(/^[0-9a-f-]{36}$/);
      expect(created.stateDir).toBe(join(teamsRoot, created.teamId));

      const cfgPath = join(created.stateDir, 'config.json');
      expect(existsSync(cfgPath)).toBe(true);
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      expect(cfg).toMatchObject({
        teamId: created.teamId,
        teamName: 'My Team',
        workspaceId: 'ws-1',
        members: [],
      });
    });

    it('lists teams scoped to the requested workspace and ignores others', async () => {
      const a1 = await runJson<{ teamId: string }>(['-w', 'ws-A', 'team', 'create', 'A1']);
      const a2 = await runJson<{ teamId: string }>(['-w', 'ws-A', 'team', 'create', 'A2']);
      await runJson(['-w', 'ws-B', 'team', 'create', 'B-only']);

      const listed = await runJson<Array<{ teamId: string }>>(['-w', 'ws-A', 'team', 'list']);
      const ids = listed.map((t) => t.teamId).sort();
      expect(ids).toEqual([a1.teamId, a2.teamId].sort());
    });

    it('refuses to create without a workspace', async () => {
      await expect(runCli(['team', 'create', 'No-ws'])).rejects.toThrow(ExitCalled);
      expect(stderrLines.join('')).toMatch(/Workspace ID required/);
    });

    it('status returns members + task stats', async () => {
      const team = await runJson<{ teamId: string }>(['-w', 'ws-1', 'team', 'create', 'T']);
      await runJson([
        'team', 'add-member', team.teamId,
        '--node-id', 'node-l', '--agent-type', 'claude-code', '--lead',
      ]);
      const status = await runJson<{
        members: Array<{ memberId: string; isLead: boolean }>;
        leadMemberId: string;
        tasks: { total: number };
      }>(['team', 'status', team.teamId]);
      expect(status.members).toHaveLength(1);
      expect(status.members[0].isLead).toBe(true);
      expect(status.leadMemberId).toBe(status.members[0].memberId);
      expect(status.tasks.total).toBe(0);
    });
  });

  describe('add-member', () => {
    it('rejects unknown agent types', async () => {
      const team = await runJson<{ teamId: string }>(['-w', 'ws-1', 'team', 'create', 'T']);
      await expect(
        runCli(['team', 'add-member', team.teamId, '--node-id', 'n1', '--agent-type', 'gpt-2']),
      ).rejects.toThrow(ExitCalled);
      expect(stderrLines.join('')).toMatch(/Invalid --agent-type/);
    });

    it('allocates predictable memberIds in order', async () => {
      const team = await runJson<{ teamId: string }>(['-w', 'ws-1', 'team', 'create', 'T']);
      const m1 = await runJson<{ memberId: string }>([
        'team', 'add-member', team.teamId, '--node-id', 'n1', '--agent-type', 'codex',
      ]);
      const m2 = await runJson<{ memberId: string }>([
        'team', 'add-member', team.teamId, '--node-id', 'n2', '--agent-type', 'codex',
      ]);
      expect(m1.memberId).toBe(`${team.teamId}-m1`);
      expect(m2.memberId).toBe(`${team.teamId}-m2`);
    });
  });

  describe('task lifecycle', () => {
    async function setupTeamWithMembers() {
      const team = await runJson<{ teamId: string }>(['-w', 'ws-1', 'team', 'create', 'T']);
      const lead = await runJson<{ memberId: string }>([
        'team', 'add-member', team.teamId, '--node-id', 'n-lead', '--agent-type', 'claude-code', '--lead',
      ]);
      const tm = await runJson<{ memberId: string }>([
        'team', 'add-member', team.teamId, '--node-id', 'n-tm', '--agent-type', 'codex',
      ]);
      return { teamId: team.teamId, leadId: lead.memberId, tmId: tm.memberId };
    }

    it('runs a full create → claim → complete cycle', async () => {
      const { teamId, leadId, tmId } = await setupTeamWithMembers();

      const task = await runJson<{ id: string; status: string }>([
        'team', 'task', 'create', teamId,
        '--member-id', leadId,
        '--title', 'Investigate ORM',
        '--description', 'Compare three options',
      ]);
      expect(task.status).toBe('pending');

      const claimed = await runJson<{ id: string; status: string; assignee: string }>([
        'team', 'task', 'claim', teamId, '--member-id', tmId,
      ]);
      expect(claimed.id).toBe(task.id);
      expect(claimed.status).toBe('in_progress');
      expect(claimed.assignee).toBe(tmId);

      const completed = await runJson<{ status: string; result: string }>([
        'team', 'task', 'complete', teamId, '--task-id', task.id, '--result', 'Done',
      ]);
      expect(completed.status).toBe('completed');
      expect(completed.result).toBe('Done');
    });

    it('blocks dependent tasks until prerequisites complete', async () => {
      const { teamId, leadId, tmId } = await setupTeamWithMembers();

      const t1 = await runJson<{ id: string }>([
        'team', 'task', 'create', teamId,
        '--member-id', leadId, '--title', 'Step 1', '--description', 'first',
      ]);
      const t2 = await runJson<{ id: string }>([
        'team', 'task', 'create', teamId,
        '--member-id', leadId, '--title', 'Step 2', '--description', 'second',
        '--deps', t1.id,
      ]);

      // Auto-claim from teammate should pick up T1 (T2 is blocked).
      const claim1 = await runJson<{ id: string }>([
        'team', 'task', 'claim', teamId, '--member-id', tmId,
      ]);
      expect(claim1.id).toBe(t1.id);

      // Second auto-claim returns null because T2 is still blocked.
      const claim2 = await runJson<{ claimed: null | { id: string } }>([
        'team', 'task', 'claim', teamId, '--member-id', tmId,
      ]);
      expect(claim2.claimed ?? null).toBeNull();

      // Complete T1 → T2 unblocks → claim succeeds.
      await runJson(['team', 'task', 'complete', teamId, '--task-id', t1.id]);
      const claim3 = await runJson<{ id: string }>([
        'team', 'task', 'claim', teamId, '--member-id', tmId,
      ]);
      expect(claim3.id).toBe(t2.id);
    });

    it('rejects task ops with cross-team member ids', async () => {
      const a = await runJson<{ teamId: string }>(['-w', 'ws-1', 'team', 'create', 'A']);
      const b = await runJson<{ teamId: string }>(['-w', 'ws-1', 'team', 'create', 'B']);
      const aMember = await runJson<{ memberId: string }>([
        'team', 'add-member', a.teamId, '--node-id', 'n-a', '--agent-type', 'codex',
      ]);

      // aMember is valid in team A but should be rejected in team B.
      await expect(
        runCli([
          'team', 'task', 'create', b.teamId,
          '--member-id', aMember.memberId, '--title', 'X', '--description', 'Y',
        ]),
      ).rejects.toThrow(ExitCalled);
      expect(stderrLines.join('')).toMatch(/does not belong to team/);
    });
  });

  describe('mailbox', () => {
    it('round-trips a message and read marks it consumed', async () => {
      const team = await runJson<{ teamId: string }>(['-w', 'ws-1', 'team', 'create', 'T']);
      const m1 = await runJson<{ memberId: string }>([
        'team', 'add-member', team.teamId, '--node-id', 'n1', '--agent-type', 'claude-code', '--lead',
      ]);
      const m2 = await runJson<{ memberId: string }>([
        'team', 'add-member', team.teamId, '--node-id', 'n2', '--agent-type', 'codex',
      ]);

      await runJson([
        'team', 'msg', 'send', team.teamId,
        '--from', m2.memberId, '--to', m1.memberId, '--content', 'hello lead',
      ]);

      const first = await runJson<{ count: number; messages: Array<{ content: string; from: string }> }>([
        'team', 'msg', 'read', team.teamId, '--member-id', m1.memberId,
      ]);
      expect(first.count).toBe(1);
      expect(first.messages[0]).toMatchObject({ content: 'hello lead', from: m2.memberId });

      const second = await runJson<{ count: number }>([
        'team', 'msg', 'read', team.teamId, '--member-id', m1.memberId,
      ]);
      expect(second.count).toBe(0);
    });

    it('rejects sender that does not belong to the team', async () => {
      const team = await runJson<{ teamId: string }>(['-w', 'ws-1', 'team', 'create', 'T']);
      const m1 = await runJson<{ memberId: string }>([
        'team', 'add-member', team.teamId, '--node-id', 'n1', '--agent-type', 'codex',
      ]);
      await expect(
        runCli([
          'team', 'msg', 'send', team.teamId,
          '--from', 'ghost', '--to', m1.memberId, '--content', 'x',
        ]),
      ).rejects.toThrow(ExitCalled);
      expect(stderrLines.join('')).toMatch(/Sender ghost does not belong to team/);
    });
  });

  describe('destroy', () => {
    it('renames the state dir into the archive root', async () => {
      const team = await runJson<{ teamId: string; stateDir: string }>([
        '-w', 'ws-1', 'team', 'create', 'T',
      ]);
      const result = await runJson<{ archivedTo: string }>([
        'team', 'destroy', team.teamId,
      ]);
      expect(existsSync(team.stateDir)).toBe(false);
      expect(existsSync(result.archivedTo)).toBe(true);
      expect(result.archivedTo.startsWith(archiveRoot)).toBe(true);
    });

    it('reports an error when team does not exist', async () => {
      await expect(runCli(['team', 'destroy', 'nonexistent-team-id'])).rejects.toThrow(ExitCalled);
      expect(stderrLines.join('')).toMatch(/Team not found/);
    });
  });
});
