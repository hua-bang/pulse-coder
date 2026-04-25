import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Mailbox } from '../mailbox.js';
import { TaskList } from '../task-list.js';
import { callTeamTool, TEAM_TOOL_SCHEMAS } from '../team-tools.js';

describe('team-tools.callTeamTool', () => {
  let stateDir: string;
  let mailbox: Mailbox;
  let taskList: TaskList;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), 'team-tools-'));
    mailbox = new Mailbox(stateDir);
    taskList = new TaskList(stateDir);
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it('exposes the expected tool surface', () => {
    const names = TEAM_TOOL_SCHEMAS.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        'team_send_message',
        'team_read_messages',
        'team_list_tasks',
        'team_claim_task',
        'team_complete_task',
        'team_create_task',
        'team_notify_lead',
        'team_submit_plan',
      ].sort(),
    );
  });

  it('routes team_send_message to the mailbox', async () => {
    const ctx = { teammateId: 'alice', mailbox, taskList };
    const out = await callTeamTool(ctx, 'team_send_message', {
      to: 'bob',
      content: 'hello',
    });
    expect(out).toMatch(/Message sent to bob/);
    const inbox = mailbox.readUnread('bob');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].from).toBe('alice');
    expect(inbox[0].content).toBe('hello');
  });

  it('routes team_create_task and team_claim_task through the shared list', async () => {
    const ctx = { teammateId: 'lead', mailbox, taskList };
    await callTeamTool(ctx, 'team_create_task', {
      title: 'inspect',
      description: 'go look',
    });

    const claimed = await callTeamTool(
      { ...ctx, teammateId: 'worker' },
      'team_claim_task',
      {},
    );
    expect(claimed).toMatch(/Claimed task: inspect/);
    expect(taskList.getByStatus('in_progress')).toHaveLength(1);
  });

  it('rejects team_submit_plan when plan-approval is disabled', async () => {
    const out = await callTeamTool(
      { teammateId: 'a', mailbox, taskList, requirePlanApproval: false },
      'team_submit_plan',
      { plan: 'do x' },
    );
    expect(out).toMatch(/only available when requirePlanApproval is enabled/);
  });

  it('throws for unknown tool names', async () => {
    await expect(
      callTeamTool({ teammateId: 'a', mailbox, taskList }, 'team_does_not_exist', {}),
    ).rejects.toThrow(/Unknown team tool/);
  });
});
