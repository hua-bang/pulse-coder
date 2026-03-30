import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { Task, CreateTaskInput, TaskStatus, TeamHooks } from './types.js';

/**
 * File-based shared task list with lock-based claiming.
 * Prevents race conditions when multiple teammates try to claim the same task.
 */
export class TaskList {
  private dir: string;
  private filePath: string;
  private lockPath: string;
  private hooks?: TeamHooks;

  constructor(stateDir: string, hooks?: TeamHooks) {
    this.dir = join(stateDir, 'tasks');
    mkdirSync(this.dir, { recursive: true });
    this.filePath = join(this.dir, 'tasks.json');
    this.lockPath = join(this.dir, 'tasks.lock');
    this.hooks = hooks;

    // Initialize empty task list if not exists
    if (!existsSync(this.filePath)) {
      this.writeTasks([]);
    }
  }

  /**
   * Create a new task and add it to the list.
   */
  async create(input: CreateTaskInput, createdBy: string): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      title: input.title,
      description: input.description,
      status: 'pending',
      deps: input.deps || [],
      assignee: input.assignee || null,
      createdBy,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // Run hook
    if (this.hooks?.onTaskCreated) {
      const feedback = await this.hooks.onTaskCreated(task);
      if (feedback) {
        throw new Error(`Task creation rejected: ${feedback}`);
      }
    }

    await this.withLock(() => {
      const tasks = this.readTasks();
      tasks.push(task);
      this.writeTasks(tasks);
    });

    return task;
  }

  /**
   * Create multiple tasks at once (batch).
   */
  async createBatch(inputs: CreateTaskInput[], createdBy: string): Promise<Task[]> {
    const tasks: Task[] = [];
    for (const input of inputs) {
      tasks.push(await this.create(input, createdBy));
    }
    return tasks;
  }

  /**
   * Attempt to claim a pending, unblocked task for a teammate.
   * Uses file locking to prevent race conditions.
   * Returns the claimed task, or null if no task is available.
   */
  async claim(teammateId: string, taskId?: string): Promise<Task | null> {
    let claimed: Task | null = null;

    await this.withLock(() => {
      const tasks = this.readTasks();

      if (taskId) {
        // Claim a specific task
        const task = tasks.find(t => t.id === taskId);
        if (task && task.status === 'pending' && this.canClaim(task, teammateId) && this.isUnblocked(task, tasks)) {
          task.status = 'in_progress';
          task.assignee = teammateId;
          task.updatedAt = Date.now();
          claimed = { ...task };
        }
      } else {
        // Auto-claim priority:
        // 1. Tasks pre-assigned to me
        // 2. Unassigned tasks
        // 3. Work stealing: tasks assigned to others (if allowSteal)
        const allPending = tasks.filter(t =>
          t.status === 'pending' && this.isUnblocked(t, tasks)
        );
        const mine = allPending.find(t => t.assignee === teammateId);
        const unassigned = allPending.find(t => !t.assignee);
        const stealable = allPending.find(t => t.assignee !== teammateId && t.assignee !== null);
        const target = mine || unassigned || stealable;

        if (target) {
          target.status = 'in_progress';
          target.assignee = teammateId;
          target.updatedAt = Date.now();
          claimed = { ...target };
        }
      }

      if (claimed) {
        this.writeTasks(tasks);
      }
    });

    return claimed;
  }

  /**
   * Mark a task as completed.
   */
  async complete(taskId: string, result?: string): Promise<Task | null> {
    let completed: Task | null = null;

    await this.withLock(() => {
      const tasks = this.readTasks();
      const task = tasks.find(t => t.id === taskId);
      if (task && task.status === 'in_progress') {
        task.status = 'completed';
        task.result = result;
        task.updatedAt = Date.now();
        completed = { ...task };
        this.writeTasks(tasks);
      }
    });

    // Run hook (outside lock)
    if (completed && this.hooks?.onTaskCompleted) {
      const feedback = await this.hooks.onTaskCompleted(completed);
      if (feedback) {
        // Revert completion
        await this.withLock(() => {
          const tasks = this.readTasks();
          const task = tasks.find(t => t.id === taskId);
          if (task) {
            task.status = 'in_progress';
            task.result = undefined;
            task.updatedAt = Date.now();
            this.writeTasks(tasks);
          }
        });
        throw new Error(`Task completion rejected: ${feedback}`);
      }
    }

    return completed;
  }

  /**
   * Mark a task as failed.
   */
  async fail(taskId: string, error?: string): Promise<Task | null> {
    let failed: Task | null = null;

    await this.withLock(() => {
      const tasks = this.readTasks();
      const task = tasks.find(t => t.id === taskId);
      if (task && task.status === 'in_progress') {
        task.status = 'failed';
        task.result = error;
        task.updatedAt = Date.now();
        failed = { ...task };
        this.writeTasks(tasks);
      }
    });

    return failed;
  }

  /**
   * Get all tasks.
   */
  getAll(): Task[] {
    return this.readTasks();
  }

  /**
   * Get a single task by ID.
   */
  get(taskId: string): Task | undefined {
    return this.readTasks().find(t => t.id === taskId);
  }

  /**
   * Get tasks by status.
   */
  getByStatus(status: TaskStatus): Task[] {
    return this.readTasks().filter(t => t.status === status);
  }

  /**
   * Get tasks assigned to a teammate.
   */
  getByAssignee(teammateId: string): Task[] {
    return this.readTasks().filter(t => t.assignee === teammateId);
  }

  /**
   * Get pending tasks that are unblocked (all deps completed).
   */
  getClaimable(): Task[] {
    const tasks = this.readTasks();
    return tasks.filter(t =>
      t.status === 'pending' && this.isUnblocked(t, tasks)
    );
  }

  /**
   * Check if all tasks are done (completed or failed).
   */
  isAllDone(): boolean {
    const tasks = this.readTasks();
    return tasks.length > 0 && tasks.every(t => t.status === 'completed' || t.status === 'failed');
  }

  /**
   * Get summary stats.
   */
  stats(): { total: number; pending: number; in_progress: number; completed: number; failed: number } {
    const tasks = this.readTasks();
    return {
      total: tasks.length,
      pending: tasks.filter(t => t.status === 'pending').length,
      in_progress: tasks.filter(t => t.status === 'in_progress').length,
      completed: tasks.filter(t => t.status === 'completed').length,
      failed: tasks.filter(t => t.status === 'failed').length,
    };
  }

  /**
   * Remove all tasks (cleanup).
   */
  clear(): void {
    this.writeTasks([]);
  }

  // ─── Internal ────────────────────────────────────────────────────

  /**
   * Check if a teammate can claim a task.
   * - Unassigned tasks: anyone can claim.
   * - Pre-assigned tasks: only the assigned teammate can claim.
   */
  private canClaim(task: Task, teammateId: string): boolean {
    return !task.assignee || task.assignee === teammateId;
  }

  private isUnblocked(task: Task, allTasks: Task[]): boolean {
    if (task.deps.length === 0) return true;
    return task.deps.every(depId => {
      const dep = allTasks.find(t => t.id === depId);
      return dep?.status === 'completed';
    });
  }

  private readTasks(): Task[] {
    if (!existsSync(this.filePath)) return [];
    try {
      return JSON.parse(readFileSync(this.filePath, 'utf-8'));
    } catch {
      return [];
    }
  }

  private writeTasks(tasks: Task[]): void {
    writeFileSync(this.filePath, JSON.stringify(tasks, null, 2), 'utf-8');
  }

  /**
   * Simple file-lock based mutual exclusion.
   * Uses O_EXCL flag for atomic lock creation.
   */
  private async withLock<T>(fn: () => T): Promise<T> {
    const maxRetries = 50;
    const retryDelayMs = 20;

    for (let i = 0; i < maxRetries; i++) {
      try {
        const fd = openSync(this.lockPath, 'wx');
        closeSync(fd);

        try {
          return fn();
        } finally {
          try { unlinkSync(this.lockPath); } catch { /* ignore */ }
        }
      } catch (err: any) {
        if (err.code === 'EEXIST') {
          // Lock held by another process, wait and retry
          await new Promise(r => setTimeout(r, retryDelayMs));
          continue;
        }
        throw err;
      }
    }

    // If we exhausted retries, force remove stale lock and try once more
    try { unlinkSync(this.lockPath); } catch { /* ignore */ }
    return fn();
  }
}
