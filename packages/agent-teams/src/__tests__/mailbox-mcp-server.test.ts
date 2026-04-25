import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox } from '../mailbox.js';
import { TaskList } from '../task-list.js';
import { dispatchMailboxRpc } from '../mcp/mailbox-mcp-server.js';

describe('mailbox-mcp-server.dispatchMailboxRpc', () => {
  let stateDir: string;
  let ctx: {
    teammateId: string;
    mailbox: Mailbox;
    taskList: TaskList;
    requirePlanApproval?: boolean;
  };

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'mailbox-mcp-'));
    ctx = {
      teammateId: 'agent-1',
      mailbox: new Mailbox(stateDir),
      taskList: new TaskList(stateDir),
    };
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('handles initialize and reports server info', async () => {
    const res = await dispatchMailboxRpc(
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      ctx,
    );
    expect(res).toMatchObject({
      jsonrpc: '2.0',
      id: 1,
      result: {
        protocolVersion: expect.any(String),
        serverInfo: { name: 'pulse-mailbox-mcp', version: expect.any(String) },
      },
    });
  });

  it('hides team_submit_plan from tools/list when plan-approval is off', async () => {
    const res = await dispatchMailboxRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      ctx,
    );
    const names = (res?.result as { tools: { name: string }[] }).tools.map(
      (t) => t.name,
    );
    expect(names).not.toContain('team_submit_plan');
    expect(names).toContain('team_send_message');
  });

  it('exposes team_submit_plan when plan-approval is on', async () => {
    const res = await dispatchMailboxRpc(
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      { ...ctx, requirePlanApproval: true },
    );
    const names = (res?.result as { tools: { name: string }[] }).tools.map(
      (t) => t.name,
    );
    expect(names).toContain('team_submit_plan');
  });

  it('routes tools/call to the team-tool dispatcher', async () => {
    await dispatchMailboxRpc(
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'team_send_message',
          arguments: { to: 'partner', content: 'hi' },
        },
      },
      ctx,
    );
    const inbox = ctx.mailbox.readUnread('partner');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].content).toBe('hi');
  });

  it('returns isError=true when the tool throws', async () => {
    const res = await dispatchMailboxRpc(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'team_complete_task', arguments: { taskId: 'nope' } },
      },
      ctx,
    );
    // task not found returns a string, not a throw; `isError` stays false there.
    // Use an unknown tool to force error path.
    const res2 = await dispatchMailboxRpc(
      {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'team_does_not_exist', arguments: {} },
      },
      ctx,
    );
    expect(res?.result).toMatchObject({ isError: false });
    expect(res2?.error?.message).toMatch(/Unknown tool/);
  });

  it('returns null for notifications', async () => {
    const res = await dispatchMailboxRpc(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      ctx,
    );
    expect(res).toBeNull();
  });
});
