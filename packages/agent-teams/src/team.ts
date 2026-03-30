import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { ILogger } from 'pulse-coder-engine';
import { Mailbox } from './mailbox.js';
import { TaskList } from './task-list.js';
import { Teammate } from './teammate.js';
import type {
  TeamConfig,
  TeamStatus,
  TeamMemberInfo,
  PersistedTeamConfig,
  TeammateOptions,
  TeammateStatus,
  TeamHooks,
  TeamEvent,
  TeamEventHandler,
  CreateTaskInput,
} from './types.js';

/**
 * Team manages the lifecycle of an agent team.
 *
 * Architecture (mirroring Claude Code Agent Teams):
 * - One Team Lead (the session that creates the team)
 * - N Teammates (independent Engine instances)
 * - Shared TaskList for coordination
 * - Mailbox for inter-agent messaging
 */
export class Team {
  readonly name: string;
  readonly stateDir: string;

  private _status: TeamStatus = 'idle';
  private mailbox: Mailbox;
  private taskList: TaskList;
  private teammates: Map<string, Teammate> = new Map();
  private logger: ILogger;
  private hooks: TeamHooks;
  private eventHandlers: TeamEventHandler[] = [];
  private configPath: string;

  constructor(config: TeamConfig, hooks?: TeamHooks) {
    this.name = config.name;
    this.logger = config.logger || console;
    this.hooks = hooks || {};

    // State directory
    this.stateDir = config.stateDir || join(homedir(), '.pulse-coder', 'teams', this.name);
    mkdirSync(this.stateDir, { recursive: true });

    this.configPath = join(this.stateDir, 'config.json');
    this.mailbox = new Mailbox(this.stateDir);
    this.taskList = new TaskList(this.stateDir, this.hooks);

    // Persist initial config
    this.persistConfig();
  }

  get status(): TeamStatus {
    return this._status;
  }

  get members(): TeamMemberInfo[] {
    return Array.from(this.teammates.values()).map(t => ({
      id: t.id,
      name: t.name,
      isLead: false,
      status: t.status,
    }));
  }

  // ─── Teammate Management ─────────────────────────────────────────

  /**
   * Spawn a new teammate with its own Engine instance.
   */
  async spawnTeammate(options: TeammateOptions): Promise<Teammate> {
    if (this.teammates.has(options.id)) {
      throw new Error(`Teammate with id '${options.id}' already exists`);
    }

    const teammate = new Teammate(
      options,
      this.mailbox,
      this.taskList,
      {
        onStatusChange: (id, status) => this.onTeammateStatusChange(id, status),
        onOutput: (id, text) => this.emit({
          type: 'teammate:output',
          timestamp: Date.now(),
          data: { id, name: options.name, text },
        }),
      }
    );

    await teammate.initialize();
    this.teammates.set(options.id, teammate);
    this.persistConfig();

    this.emit({
      type: 'teammate:spawned',
      timestamp: Date.now(),
      data: { id: options.id, name: options.name },
    });

    this.logger.info(`Teammate spawned: ${options.name} (${options.id})`);
    return teammate;
  }

  /**
   * Spawn multiple teammates in parallel.
   */
  async spawnTeammates(optionsList: TeammateOptions[]): Promise<Teammate[]> {
    return Promise.all(optionsList.map(opts => this.spawnTeammate(opts)));
  }

  /**
   * Get a teammate by ID.
   */
  getTeammate(id: string): Teammate | undefined {
    return this.teammates.get(id);
  }

  /**
   * Get all teammates.
   */
  getTeammates(): Teammate[] {
    return Array.from(this.teammates.values());
  }

  /**
   * Request a teammate to shut down.
   */
  async shutdownTeammate(id: string): Promise<void> {
    const teammate = this.teammates.get(id);
    if (!teammate) return; // Already removed or unknown — idempotent
    if (teammate.status === 'stopped') return; // Already stopped

    // Send shutdown request via mailbox
    this.mailbox.send('lead', id, 'shutdown_request', 'Please shut down gracefully.');
    await teammate.requestShutdown();

    this.emit({
      type: 'teammate:stopped',
      timestamp: Date.now(),
      data: { id, name: teammate.name },
    });
  }

  /**
   * Shut down all teammates.
   */
  async shutdownAll(): Promise<void> {
    const shutdowns = Array.from(this.teammates.keys()).map(id =>
      this.shutdownTeammate(id).catch(err =>
        this.logger.error(`Error shutting down ${id}`, err)
      )
    );
    await Promise.all(shutdowns);
  }

  // ─── Task Management ─────────────────────────────────────────────

  /**
   * Create tasks in the shared task list (typically done by lead).
   */
  async createTasks(tasks: CreateTaskInput[], createdBy = 'lead'): Promise<void> {
    for (const task of tasks) {
      const created = await this.taskList.create(task, createdBy);
      this.emit({
        type: 'task:created',
        timestamp: Date.now(),
        data: { task: created },
      });
    }
  }

  /**
   * Get the task list instance for direct access.
   */
  getTaskList(): TaskList {
    return this.taskList;
  }

  /**
   * Get the mailbox instance.
   */
  getMailbox(): Mailbox {
    return this.mailbox;
  }

  // ─── Team Execution ──────────────────────────────────────────────

  /**
   * Run the team: dispatch tasks to teammates and wait for completion.
   *
   * This is the main execution loop:
   * 1. Each teammate claims and works on tasks
   * 2. When a task completes, dependent tasks become unblocked
   * 3. Continues until all tasks are done or no progress can be made
   */
  async run(options?: { timeoutMs?: number; concurrency?: number }): Promise<{ results: Record<string, string>; stats: ReturnType<TaskList['stats']> }> {
    this._status = 'running';
    this.emit({ type: 'team:started', timestamp: Date.now(), data: { name: this.name } });

    const timeoutMs = options?.timeoutMs || 30 * 60 * 1000; // 30min default
    const concurrency = options?.concurrency || 0; // 0 = unlimited
    const startTime = Date.now();
    const results: Record<string, string> = {};

    const allTeammates = Array.from(this.teammates.values());

    if (concurrency > 0 && concurrency < allTeammates.length) {
      // Run with concurrency limit using a pool
      await this.runWithConcurrencyLimit(allTeammates, results, startTime, timeoutMs, concurrency);
    } else {
      // Unlimited: run all in parallel
      const runners = allTeammates.map(teammate =>
        this.runTeammateLoop(teammate, results, startTime, timeoutMs)
      );
      await Promise.allSettled(runners);
    }

    const stats = this.taskList.stats();
    this._status = stats.failed > 0 ? 'failed' : 'completed';

    this.emit({ type: 'team:completed', timestamp: Date.now(), data: { stats } });
    return { results, stats };
  }

  /**
   * Run teammate loops with a concurrency limit.
   * At most `limit` teammates run simultaneously; when one finishes, the next starts.
   */
  private async runWithConcurrencyLimit(
    teammates: Teammate[],
    results: Record<string, string>,
    startTime: number,
    timeoutMs: number,
    limit: number,
  ): Promise<void> {
    const queue = [...teammates];
    const active = new Set<Promise<void>>();

    const startNext = (): void => {
      if (queue.length === 0) return;
      const teammate = queue.shift()!;
      const p = this.runTeammateLoop(teammate, results, startTime, timeoutMs).then(() => {
        active.delete(p);
      });
      active.add(p);
    };

    // Fill initial pool
    for (let i = 0; i < Math.min(limit, queue.length); i++) {
      startNext();
    }

    // As each finishes, start the next
    while (active.size > 0) {
      await Promise.race(active);
      startNext();
    }
  }

  /**
   * Internal loop for a single teammate: claim tasks, execute, repeat.
   *
   * Flow:
   * 1. Process incoming messages (shutdown, plan approval, etc.)
   * 2. If in plan mode, wait for approval before proceeding
   * 3. Claim next available task
   * 4. Execute the task
   * 5. Auto-complete if the teammate didn't mark it via tool
   * 6. Repeat
   */
  private async runTeammateLoop(
    teammate: Teammate,
    results: Record<string, string>,
    startTime: number,
    timeoutMs: number,
  ): Promise<void> {
    let idleWaitCount = 0;
    const maxIdleWaits = 300; // 5min of true idle (no in-progress tasks) before giving up

    while (Date.now() - startTime < timeoutMs) {
      // Step 1: Process incoming messages
      const messages = teammate.readMessages();
      for (const msg of messages) {
        if (msg.type === 'shutdown_request') {
          this.emit({
            type: 'teammate:idle',
            timestamp: Date.now(),
            data: { id: teammate.id, name: teammate.name, reason: 'shutdown_requested' },
          });
          return;
        }
        // Plan approval responses are handled inside teammate.checkPlanApproval()
        // Other messages are injected into the next run() call via readUnread
      }

      // Step 2: If in plan mode, wait for approval
      if (teammate.planMode) {
        const approval = teammate.checkPlanApproval();
        if (approval) {
          if (!approval.approved) {
            // Rejected — re-run with feedback
            await teammate.run(`Your plan was rejected. Feedback: ${approval.feedback}\n\nPlease revise your plan and resubmit.`);
            continue;
          }
          // Approved — fall through to claim tasks
        } else {
          // Still waiting for approval
          await new Promise(r => setTimeout(r, 1000));
          continue;
        }
      }

      // Step 3: Try to claim a task
      const task = await teammate.claimTask();
      if (!task) {
        // No task available - check if all done
        if (this.taskList.isAllDone()) break;

        // Check idle hook
        if (this.hooks.onTeammateIdle) {
          const feedback = await this.hooks.onTeammateIdle(teammate.id, teammate.name);
          if (feedback) {
            idleWaitCount = 0;
            await teammate.run(feedback);
            continue;
          }
        }

        // Wait briefly and retry
        await new Promise(r => setTimeout(r, 1000));

        // Check again
        if (this.taskList.isAllDone()) break;

        // No progress possible: nothing claimable and nothing in progress
        const claimable = this.taskList.getClaimable();
        const inProgress = this.taskList.getByStatus('in_progress');
        if (claimable.length === 0 && inProgress.length === 0) break;

        // If there are in-progress tasks that might unblock deps, reset idle counter —
        // only count toward timeout when truly nothing is happening
        if (inProgress.length > 0) {
          idleWaitCount = 0;
        } else {
          idleWaitCount++;
        }

        // Give up after too many truly-idle cycles (no in-progress tasks)
        if (idleWaitCount >= maxIdleWaits) {
          this.emit({
            type: 'teammate:idle',
            timestamp: Date.now(),
            data: { id: teammate.id, name: teammate.name, reason: 'max_idle_reached' },
          });
          break;
        }

        continue;
      }

      // Reset idle counter on successful claim
      idleWaitCount = 0;

      this.emit({
        type: 'task:claimed',
        timestamp: Date.now(),
        data: { taskId: task.id, taskTitle: task.title, teammateId: teammate.id, teammateName: teammate.name },
      });

      // Step 4: Execute the task
      try {
        // Build context-aware prompt
        const taskContext = this.buildTaskContext(task.id);
        const prompt = [
          `## Task: ${task.title}`,
          ``,
          task.description,
          ``,
          `Task ID: ${task.id}`,
          taskContext ? `\n## Context from completed dependencies\n${taskContext}` : '',
          ``,
          `Complete this task thoroughly. When done, use the team_complete_task tool with task ID "${task.id}" and a result summary.`,
          `You can also use team_send_message to share findings with other teammates, or team_notify_lead to report to the lead.`,
        ].filter(Boolean).join('\n');

        this.emit({
          type: 'teammate:run_start',
          timestamp: Date.now(),
          data: { id: teammate.id, name: teammate.name, taskId: task.id, taskTitle: task.title },
        });

        const runStart = Date.now();
        const output = await teammate.run(prompt);
        const durationMs = Date.now() - runStart;
        results[task.id] = output;

        this.emit({
          type: 'teammate:run_end',
          timestamp: Date.now(),
          data: { id: teammate.id, name: teammate.name, taskId: task.id, taskTitle: task.title, durationMs },
        });

        // Auto-complete if teammate didn't use tool
        const currentTask = this.taskList.get(task.id);
        if (currentTask?.status === 'in_progress') {
          await teammate.completeTask(task.id, output);
        }

        this.emit({
          type: 'task:completed',
          timestamp: Date.now(),
          data: { taskId: task.id, taskTitle: task.title, teammateId: teammate.id },
        });
      } catch (err: any) {
        this.logger.error(`Task ${task.id} failed`, err);
        await teammate.failTask(task.id, err.message);

        this.emit({
          type: 'task:failed',
          timestamp: Date.now(),
          data: { taskId: task.id, taskTitle: task.title, error: err.message },
        });
      }
    }
  }

  /**
   * Build context from completed dependency tasks (results) for a given task.
   */
  private buildTaskContext(taskId: string): string {
    const task = this.taskList.get(taskId);
    if (!task || task.deps.length === 0) return '';

    const depResults = task.deps
      .map(depId => this.taskList.get(depId))
      .filter((t): t is NonNullable<typeof t> => !!t && t.status === 'completed' && !!t.result)
      .map(t => {
        const result = t.result!.length > 1500 ? t.result!.slice(0, 1500) + '...(truncated)' : t.result!;
        return `### ${t.title}\n${result}`;
      });

    return depResults.length > 0 ? depResults.join('\n\n') : '';
  }

  // ─── Cleanup ─────────────────────────────────────────────────────

  /**
   * Clean up team resources.
   * Shuts down all teammates and removes state files.
   */
  async cleanup(): Promise<void> {
    // Shut down any remaining teammates (idempotent)
    try { await this.shutdownAll(); } catch { /* best effort */ }
    this.mailbox.clearAll();
    this.taskList.clear();

    // Remove state directory
    try {
      rmSync(this.stateDir, { recursive: true, force: true });
    } catch {
      // Best effort
    }

    this.emit({ type: 'team:cleanup', timestamp: Date.now(), data: { name: this.name } });
    this.logger.info(`Team cleaned up: ${this.name}`);
  }

  // ─── Events ──────────────────────────────────────────────────────

  /**
   * Subscribe to team events.
   */
  on(handler: TeamEventHandler): () => void {
    this.eventHandlers.push(handler);
    return () => {
      this.eventHandlers = this.eventHandlers.filter(h => h !== handler);
    };
  }

  private emit(event: TeamEvent): void {
    for (const handler of this.eventHandlers) {
      try {
        handler(event);
      } catch (err) {
        this.logger.error('Event handler error', err as Error);
      }
    }
  }

  // ─── Teammate callbacks ───────────────────────────────────────────

  private onTeammateStatusChange(id: string, status: TeammateStatus): void {
    this.emit({
      type: 'teammate:status',
      timestamp: Date.now(),
      data: { id, status },
    });
    this.persistConfig();
  }

  // ─── Persistence ─────────────────────────────────────────────────

  private persistConfig(): void {
    const config: PersistedTeamConfig = {
      name: this.name,
      createdAt: Date.now(),
      members: this.members,
    };
    writeFileSync(this.configPath, JSON.stringify(config, null, 2), 'utf-8');
  }

  /**
   * Load an existing team from state dir.
   */
  static loadConfig(stateDir: string): PersistedTeamConfig | null {
    const configPath = join(stateDir, 'config.json');
    if (!existsSync(configPath)) return null;
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch {
      return null;
    }
  }
}
