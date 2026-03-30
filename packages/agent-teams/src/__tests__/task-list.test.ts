import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TaskList } from '../task-list.js';

describe('TaskList', () => {
  let dir: string;
  let taskList: TaskList;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tasklist-test-'));
    taskList = new TaskList(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('should create a task', async () => {
    const task = await taskList.create({ title: 'Test task', description: 'Do something' }, 'lead');
    expect(task.title).toBe('Test task');
    expect(task.status).toBe('pending');
    expect(task.assignee).toBeNull();
    expect(task.createdBy).toBe('lead');
  });

  it('should claim a task', async () => {
    const task = await taskList.create({ title: 'Task 1', description: 'Do it' }, 'lead');
    const claimed = await taskList.claim('alice');
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(task.id);
    expect(claimed!.status).toBe('in_progress');
    expect(claimed!.assignee).toBe('alice');
  });

  it('should not double-claim a task', async () => {
    await taskList.create({ title: 'Task 1', description: 'Do it' }, 'lead');
    await taskList.claim('alice');
    const second = await taskList.claim('bob');
    expect(second).toBeNull();
  });

  it('should claim a specific task by ID', async () => {
    const t1 = await taskList.create({ title: 'Task 1', description: 'First' }, 'lead');
    const t2 = await taskList.create({ title: 'Task 2', description: 'Second' }, 'lead');

    const claimed = await taskList.claim('alice', t2.id);
    expect(claimed!.id).toBe(t2.id);
  });

  it('should complete a task', async () => {
    const task = await taskList.create({ title: 'Task 1', description: 'Do it' }, 'lead');
    await taskList.claim('alice', task.id);
    const completed = await taskList.complete(task.id, 'Done!');
    expect(completed!.status).toBe('completed');
    expect(completed!.result).toBe('Done!');
  });

  it('should fail a task', async () => {
    const task = await taskList.create({ title: 'Task 1', description: 'Do it' }, 'lead');
    await taskList.claim('alice', task.id);
    const failed = await taskList.fail(task.id, 'Oops');
    expect(failed!.status).toBe('failed');
    expect(failed!.result).toBe('Oops');
  });

  it('should respect task dependencies', async () => {
    const t1 = await taskList.create({ title: 'Task 1', description: 'First' }, 'lead');
    const t2 = await taskList.create({ title: 'Task 2', description: 'Depends on T1', deps: [t1.id] }, 'lead');

    // t2 should not be claimable yet
    const claimable = taskList.getClaimable();
    expect(claimable).toHaveLength(1);
    expect(claimable[0].id).toBe(t1.id);

    // Complete t1, then t2 should become claimable
    await taskList.claim('alice', t1.id);
    await taskList.complete(t1.id, 'Done');

    const nowClaimable = taskList.getClaimable();
    expect(nowClaimable).toHaveLength(1);
    expect(nowClaimable[0].id).toBe(t2.id);
  });

  it('should report isAllDone correctly', async () => {
    const t1 = await taskList.create({ title: 'Task 1', description: 'Do it' }, 'lead');
    expect(taskList.isAllDone()).toBe(false);

    await taskList.claim('alice', t1.id);
    await taskList.complete(t1.id, 'Done');
    expect(taskList.isAllDone()).toBe(true);
  });

  it('should allow pre-assigned teammate to claim their task', async () => {
    const t1 = await taskList.create({ title: 'T1', description: '', assignee: 'alice' }, 'lead');

    // Alice (assigned) can claim
    const claimed = await taskList.claim('alice');
    expect(claimed).not.toBeNull();
    expect(claimed!.id).toBe(t1.id);
  });

  it('should allow work stealing of pre-assigned tasks when no other options', async () => {
    await taskList.create({ title: 'T1', description: '', assignee: 'alice' }, 'lead');

    // Bob can steal Alice's task (work stealing) when there are no unassigned tasks
    const claimed = await taskList.claim('bob');
    expect(claimed).not.toBeNull();
    expect(claimed!.title).toBe('T1');
    expect(claimed!.assignee).toBe('bob'); // Reassigned to Bob
  });

  it('should prioritize assigned tasks over unassigned ones', async () => {
    await taskList.create({ title: 'Unassigned', description: '' }, 'lead');
    const mine = await taskList.create({ title: 'Mine', description: '', assignee: 'alice' }, 'lead');

    // Alice should get her assigned task first
    const claimed = await taskList.claim('alice');
    expect(claimed!.id).toBe(mine.id);
    expect(claimed!.title).toBe('Mine');
  });

  it('should prefer unassigned tasks over stealing from others', async () => {
    const free = await taskList.create({ title: 'Free', description: '' }, 'lead');
    await taskList.create({ title: 'Alices', description: '', assignee: 'alice' }, 'lead');

    // Bob should get the unassigned task, not steal Alice's
    const claimed = await taskList.claim('bob');
    expect(claimed!.id).toBe(free.id);
    expect(claimed!.title).toBe('Free');
  });

  it('should report stats', async () => {
    await taskList.create({ title: 'T1', description: '' }, 'lead');
    await taskList.create({ title: 'T2', description: '' }, 'lead');
    const t3 = await taskList.create({ title: 'T3', description: '' }, 'lead');

    await taskList.claim('alice', t3.id);

    const stats = taskList.stats();
    expect(stats.total).toBe(3);
    expect(stats.pending).toBe(2);
    expect(stats.in_progress).toBe(1);
    expect(stats.completed).toBe(0);
  });

  it('should get tasks by assignee', async () => {
    const t1 = await taskList.create({ title: 'T1', description: '' }, 'lead');
    await taskList.create({ title: 'T2', description: '' }, 'lead');

    await taskList.claim('alice', t1.id);

    const aliceTasks = taskList.getByAssignee('alice');
    expect(aliceTasks).toHaveLength(1);
    expect(aliceTasks[0].title).toBe('T1');
  });

  it('should reject task creation via hook', async () => {
    const hookList = new TaskList(dir, {
      onTaskCreated: async () => 'Not allowed',
    });

    await expect(hookList.create({ title: 'Bad', description: '' }, 'lead'))
      .rejects.toThrow('Task creation rejected: Not allowed');
  });

  it('should reject task completion via hook', async () => {
    const hookList = new TaskList(dir, {
      onTaskCompleted: async () => 'Not good enough',
    });

    // We need to create without hook, then add hook
    const task = await taskList.create({ title: 'T1', description: '' }, 'lead');
    await taskList.claim('alice', task.id);

    // Now complete via hookList (shares same file)
    await expect(hookList.complete(task.id, 'Result'))
      .rejects.toThrow('Task completion rejected: Not good enough');
  });

  it('should batch-create tasks', async () => {
    const tasks = await taskList.createBatch([
      { title: 'T1', description: 'First' },
      { title: 'T2', description: 'Second' },
      { title: 'T3', description: 'Third' },
    ], 'lead');

    expect(tasks).toHaveLength(3);
    expect(taskList.getAll()).toHaveLength(3);
  });

  it('should clear all tasks', async () => {
    await taskList.create({ title: 'T1', description: '' }, 'lead');
    await taskList.create({ title: 'T2', description: '' }, 'lead');
    taskList.clear();
    expect(taskList.getAll()).toHaveLength(0);
  });
});
