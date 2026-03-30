import { Engine } from 'pulse-coder-engine';
import type { Context, ILogger } from 'pulse-coder-engine';
import { z } from 'zod';
import { Team } from './team.js';
import { planTeam, buildTeammateOptionsFromPlan } from './planner.js';
import type {
  EngineOptions,
  TeamConfig,
  TeamHooks,
  TeammateOptions,
  CreateTaskInput,
  Task,
  TeamEvent,
  TeamEventHandler,
} from './types.js';

/**
 * TeamLead options.
 */
export interface TeamLeadOptions {
  /** Team name. */
  teamName: string;
  /** State directory override. */
  stateDir?: string;
  /** Engine options for the lead's own Engine (used for planning & coordination). */
  engineOptions?: EngineOptions;
  /** Default engine options shared across all teammates. */
  defaultTeammateEngineOptions?: EngineOptions;
  /** Model override for the lead. */
  model?: string;
  /** Hooks. */
  hooks?: TeamHooks;
  /** Logger. */
  logger?: ILogger;
}

/**
 * TeamLead is the main orchestrator for an agent team.
 *
 * It wraps a Team and adds:
 * 1. LLM-driven task planning (decompose a goal into sub-tasks)
 * 2. Lead-specific tools for managing teammates
 * 3. Automated plan-then-execute flow
 * 4. Plan approval workflow
 * 5. Result synthesis
 */
export class TeamLead {
  readonly team: Team;

  private engine: Engine;
  private context: Context = { messages: [] };
  private logger: ILogger;
  private defaultTeammateEngineOptions?: EngineOptions;
  private _model?: string;

  constructor(options: TeamLeadOptions) {
    this.logger = options.logger || console;
    this._model = options.model;
    this.defaultTeammateEngineOptions = options.defaultTeammateEngineOptions;

    // Create the team
    this.team = new Team(
      {
        name: options.teamName,
        stateDir: options.stateDir,
        logger: this.logger,
      },
      options.hooks,
    );

    // Create the lead's own Engine (for planning, synthesis, coordination)
    this.engine = new Engine({
      ...options.engineOptions,
      model: options.model || options.engineOptions?.model,
      logger: this.logger,
      tools: {
        ...options.engineOptions?.tools,
        ...this.buildLeadTools(),
      },
    });
  }

  /**
   * Initialize the lead's engine.
   */
  async initialize(): Promise<void> {
    await this.engine.initialize();
  }

  // ─── High-level flows ────────────────────────────────────────────

  /**
   * Full automated flow: plan → spawn → execute → synthesize.
   *
   * 1. Uses LLM to decompose the task into teammates + sub-tasks
   * 2. Spawns teammates
   * 3. Creates tasks with dependencies
   * 4. Runs the team
   * 5. Synthesizes results
   */
  async orchestrate(
    taskDescription: string,
    options?: {
      onPlan?: (plan: Awaited<ReturnType<typeof planTeam>>) => Promise<boolean>;
      timeoutMs?: number;
      /** Max teammates running concurrently (0 = unlimited). Useful for API RPM limits. */
      concurrency?: number;
    },
  ): Promise<{ plan: Awaited<ReturnType<typeof planTeam>>; results: Record<string, string>; synthesis: string }> {
    // Phase 1: Plan
    this.logger.info('Phase 1: Planning team structure and tasks...');
    const plan = await planTeam(taskDescription, { logger: this.logger });

    this.logger.info(`Plan: ${plan.teammates.length} teammates, ${plan.tasks.length} tasks`);

    // Optional: let caller approve the plan
    if (options?.onPlan) {
      const approved = await options.onPlan(plan);
      if (!approved) {
        throw new Error('Plan rejected by user');
      }
    }

    // Phase 2: Spawn teammates
    this.logger.info('Phase 2: Spawning teammates...');
    const teammateOptions = buildTeammateOptionsFromPlan(
      plan,
      this.defaultTeammateEngineOptions,
      this.logger,
    );
    await this.team.spawnTeammates(teammateOptions);

    // Phase 3: Create tasks with dependencies
    this.logger.info('Phase 3: Creating tasks...');
    const taskIdByTitle = await this.createTasksFromPlan(plan);

    // Phase 4: Run
    this.logger.info('Phase 4: Running team...');
    const { results, stats } = await this.team.run({
      timeoutMs: options?.timeoutMs,
      concurrency: options?.concurrency,
    });

    // Phase 5: Synthesize
    this.logger.info('Phase 5: Synthesizing results...');
    const synthesis = await this.synthesizeResults(taskDescription, results, stats);

    return { plan, results, synthesis };
  }

  /**
   * Manual flow: just spawn teammates and create tasks.
   * Caller drives execution.
   */
  async setupTeam(
    teammates: TeammateOptions[],
    tasks: CreateTaskInput[],
  ): Promise<void> {
    await this.team.spawnTeammates(teammates);
    await this.team.createTasks(tasks);
  }

  /**
   * Send a direct message to a teammate (lead → teammate).
   */
  sendMessage(teammateId: string, content: string): void {
    this.team.getMailbox().send('lead', teammateId, 'message', content);
  }

  /**
   * Broadcast a message to all teammates.
   */
  broadcast(content: string): void {
    const ids = this.team.getTeammates().map(t => t.id);
    this.team.getMailbox().broadcast('lead', ids, content);
  }

  /**
   * Read messages sent to the lead.
   */
  readMessages() {
    return this.team.getMailbox().readUnread('lead');
  }

  /**
   * Subscribe to team events.
   */
  on(handler: TeamEventHandler): () => void {
    return this.team.on(handler);
  }

  // ─── Plan approval ───────────────────────────────────────────────

  /**
   * Approve a teammate's plan, taking them out of plan mode.
   */
  approvePlan(teammateId: string): void {
    this.team.getMailbox().send('lead', teammateId, 'plan_approval_response', JSON.stringify({ approved: true }));
  }

  /**
   * Reject a teammate's plan with feedback.
   */
  rejectPlan(teammateId: string, feedback: string): void {
    this.team.getMailbox().send('lead', teammateId, 'plan_approval_response', JSON.stringify({ approved: false, feedback }));
  }

  // ─── Internal ────────────────────────────────────────────────────

  /**
   * Create tasks from a plan, resolving depNames → real task IDs.
   */
  private async createTasksFromPlan(
    plan: Awaited<ReturnType<typeof planTeam>>,
  ): Promise<Map<string, string>> {
    const taskList = this.team.getTaskList();
    const titleToId = new Map<string, string>();

    // First pass: create all tasks without deps to get IDs
    const createdTasks: Task[] = [];
    for (const pt of plan.tasks) {
      const task = await taskList.create({
        title: pt.title,
        description: pt.description,
        assignee: pt.assignTo ? this.resolveTeammateId(pt.assignTo) : undefined,
        deps: [], // filled in second pass
      }, 'lead');
      titleToId.set(pt.title, task.id);
      createdTasks.push(task);
    }

    // Second pass: update deps by resolving depNames to IDs
    // We need to read and rewrite since TaskList doesn't have an update method.
    // For now, we create tasks with deps resolved upfront. Let's do it properly.
    // Actually, let's re-create with proper deps.
    taskList.clear();

    for (const pt of plan.tasks) {
      const deps = (pt.depNames || [])
        .map(name => titleToId.get(name))
        .filter((id): id is string => !!id);

      await taskList.create({
        title: pt.title,
        description: pt.description,
        assignee: pt.assignTo ? this.resolveTeammateId(pt.assignTo) : undefined,
        deps,
      }, 'lead');
    }

    return titleToId;
  }

  /**
   * Resolve a teammate name to its ID.
   */
  private resolveTeammateId(name: string): string | undefined {
    const mate = this.team.getTeammates().find(t => t.name === name);
    return mate?.id;
  }

  /**
   * Use the lead's Engine to synthesize results from all teammates.
   */
  private async synthesizeResults(
    originalTask: string,
    results: Record<string, string>,
    stats: { total: number; completed: number; failed: number },
  ): Promise<string> {
    const tasks = this.team.getTaskList().getAll();
    const taskSummaries = tasks.map(t => {
      const output = results[t.id] || t.result || '(no output)';
      // Truncate long outputs
      const truncated = output.length > 2000 ? output.slice(0, 2000) + '...(truncated)' : output;
      return `### Task: ${t.title} [${t.status}]\nAssignee: ${t.assignee || 'unassigned'}\nOutput:\n${truncated}`;
    }).join('\n\n---\n\n');

    const synthesisPrompt = `You are the team lead. Your team has completed their work. Synthesize the results into a coherent summary.

## Original Task
${originalTask}

## Team Results (${stats.completed}/${stats.total} completed, ${stats.failed} failed)

${taskSummaries}

## Instructions
- Provide a comprehensive synthesis of all teammates' findings/outputs.
- Highlight key decisions, findings, and deliverables.
- Note any failures or gaps.
- Keep it concise but thorough.`;

    this.context.messages.push({ role: 'user', content: synthesisPrompt });

    try {
      const result = await this.engine.run(this.context, {
        systemPrompt: 'You are a team lead synthesizing results from your teammates. Be concise and structured.',
        onCompacted: (newMessages) => {
          this.context.messages = newMessages;
        },
        onResponse: (messages) => {
          this.context.messages.push(...messages);
        },
      });
      return result;
    } catch (err: any) {
      this.logger.error('Synthesis failed', err);
      return `Synthesis failed: ${err.message}\n\nRaw results:\n${taskSummaries}`;
    }
  }

  /**
   * Build tools available to the lead's Engine for interactive coordination.
   */
  private buildLeadTools() {
    const lead = this;

    return {
      team_spawn_teammate: {
        name: 'team_spawn_teammate',
        description: 'Spawn a new teammate with a specific role and instructions.',
        inputSchema: z.object({
          name: z.string().describe('Teammate name/role (e.g. "security-reviewer")'),
          spawnPrompt: z.string().describe('Instructions for this teammate'),
          model: z.string().optional().describe('Model override for this teammate'),
          requirePlanApproval: z.boolean().optional().describe('Require plan approval before implementation'),
        }),
        execute: async (input: { name: string; spawnPrompt: string; model?: string; requirePlanApproval?: boolean }) => {
          const id = `${input.name}-${Date.now()}`;
          await lead.team.spawnTeammate({
            id,
            name: input.name,
            spawnPrompt: input.spawnPrompt,
            model: input.model,
            requirePlanApproval: input.requirePlanApproval,
            engineOptions: lead.defaultTeammateEngineOptions,
            logger: lead.logger,
          });
          return `Teammate spawned: ${input.name} (id: ${id})`;
        },
      },
      team_create_tasks: {
        name: 'team_create_tasks',
        description: 'Create one or more tasks in the shared task list.',
        inputSchema: z.object({
          tasks: z.array(z.object({
            title: z.string(),
            description: z.string(),
            assignee: z.string().optional().describe('Teammate ID to assign'),
            deps: z.array(z.string()).optional().describe('Task IDs this depends on'),
          })),
        }),
        execute: async (input: { tasks: CreateTaskInput[] }) => {
          await lead.team.createTasks(input.tasks);
          return `Created ${input.tasks.length} task(s): ${input.tasks.map(t => t.title).join(', ')}`;
        },
      },
      team_send_message: {
        name: 'team_send_message',
        description: 'Send a message to a specific teammate.',
        inputSchema: z.object({
          to: z.string().describe('Teammate ID'),
          content: z.string().describe('Message content'),
        }),
        execute: async (input: { to: string; content: string }) => {
          lead.sendMessage(input.to, input.content);
          return `Message sent to ${input.to}`;
        },
      },
      team_broadcast: {
        name: 'team_broadcast',
        description: 'Broadcast a message to all teammates.',
        inputSchema: z.object({
          content: z.string().describe('Message content'),
        }),
        execute: async (input: { content: string }) => {
          lead.broadcast(input.content);
          return `Broadcast sent to ${lead.team.getTeammates().length} teammates`;
        },
      },
      team_read_messages: {
        name: 'team_read_messages',
        description: 'Read unread messages sent to the lead.',
        inputSchema: z.object({}),
        execute: async () => {
          const messages = lead.readMessages();
          if (messages.length === 0) return 'No unread messages.';
          return messages.map(m => `[from: ${m.from}] ${m.content}`).join('\n---\n');
        },
      },
      team_list_teammates: {
        name: 'team_list_teammates',
        description: 'List all teammates with their current status.',
        inputSchema: z.object({}),
        execute: async () => {
          const members = lead.team.members;
          if (members.length === 0) return 'No teammates.';
          return members.map(m => `${m.name} (${m.id}) [${m.status}]`).join('\n');
        },
      },
      team_list_tasks: {
        name: 'team_list_tasks',
        description: 'List all tasks with their current status.',
        inputSchema: z.object({}),
        execute: async () => {
          const tasks = lead.team.getTaskList().getAll();
          if (tasks.length === 0) return 'No tasks.';
          return tasks.map(t =>
            `[${t.status}] ${t.title} (id: ${t.id}, assignee: ${t.assignee || 'none'})`
          ).join('\n');
        },
      },
      team_task_stats: {
        name: 'team_task_stats',
        description: 'Get task completion statistics.',
        inputSchema: z.object({}),
        execute: async () => {
          const stats = lead.team.getTaskList().stats();
          return `Total: ${stats.total} | Pending: ${stats.pending} | In Progress: ${stats.in_progress} | Completed: ${stats.completed} | Failed: ${stats.failed}`;
        },
      },
      team_shutdown_teammate: {
        name: 'team_shutdown_teammate',
        description: 'Request a teammate to shut down.',
        inputSchema: z.object({
          id: z.string().describe('Teammate ID to shut down'),
        }),
        execute: async (input: { id: string }) => {
          await lead.team.shutdownTeammate(input.id);
          return `Shutdown requested for ${input.id}`;
        },
      },
      team_approve_plan: {
        name: 'team_approve_plan',
        description: 'Approve a teammate plan, allowing them to proceed with implementation.',
        inputSchema: z.object({
          teammateId: z.string().describe('Teammate ID whose plan to approve'),
        }),
        execute: async (input: { teammateId: string }) => {
          lead.approvePlan(input.teammateId);
          return `Plan approved for ${input.teammateId}`;
        },
      },
      team_reject_plan: {
        name: 'team_reject_plan',
        description: 'Reject a teammate plan with feedback, keeping them in plan mode.',
        inputSchema: z.object({
          teammateId: z.string().describe('Teammate ID whose plan to reject'),
          feedback: z.string().describe('Feedback explaining why the plan was rejected'),
        }),
        execute: async (input: { teammateId: string; feedback: string }) => {
          lead.rejectPlan(input.teammateId, input.feedback);
          return `Plan rejected for ${input.teammateId} with feedback`;
        },
      },
      team_run: {
        name: 'team_run',
        description: 'Start the team execution. All teammates will begin claiming and working on tasks.',
        inputSchema: z.object({
          timeoutMs: z.number().optional().describe('Timeout in ms (default: 30 min)'),
        }),
        execute: async (input: { timeoutMs?: number }) => {
          const { stats } = await lead.team.run({ timeoutMs: input.timeoutMs });
          return `Team run complete. ${stats.completed}/${stats.total} tasks completed, ${stats.failed} failed.`;
        },
      },
      team_cleanup: {
        name: 'team_cleanup',
        description: 'Clean up the team, shutting down all teammates and removing state.',
        inputSchema: z.object({}),
        execute: async () => {
          await lead.team.shutdownAll();
          await lead.team.cleanup();
          return 'Team cleaned up.';
        },
      },
    };
  }
}
