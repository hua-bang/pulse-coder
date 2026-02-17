import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TaskListService } from './index.js';

describe('TaskListService', () => {
  let storageDir: string;

  beforeEach(async () => {
    storageDir = await mkdtemp(path.join(tmpdir(), 'pulse-coder-tasks-'));
  });

  afterEach(async () => {
    await rm(storageDir, { recursive: true, force: true });
  });

  it('normalizes task list id and de-duplicates dependencies', async () => {
    const service = new TaskListService('my task/list', storageDir);

    const task = await service.createTask({
      title: 'setup tests',
      dependencies: ['dep-a', ' dep-a ', 'dep-b', '']
    });

    expect(service.taskListId).toBe('my-task-list');
    expect(task.dependencies).toEqual(['dep-a', 'dep-b']);

    const snapshot = await service.snapshot();
    expect(snapshot.total).toBe(1);
    expect(snapshot.storagePath).toContain(path.join(storageDir, 'my-task-list.json'));
  });

  it('handles blocked and completed status transitions', async () => {
    const service = new TaskListService('status-flow', storageDir);

    const created = await service.createTask({
      title: 'investigate failure',
      status: 'blocked'
    });
    expect(created.blockedReason).toBe('Blocked without reason');

    const inProgress = await service.updateTask({ id: created.id, status: 'in_progress' });
    expect(inProgress?.blockedReason).toBeUndefined();

    const completed = await service.updateTask({ id: created.id, status: 'completed' });
    expect(completed?.completedAt).toBeTypeOf('number');

    const activeTasks = await service.listTasks({ includeCompleted: false });
    expect(activeTasks).toHaveLength(0);
  });
});
