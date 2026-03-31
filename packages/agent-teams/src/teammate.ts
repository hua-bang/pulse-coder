import { Engine } from 'pulse-coder-engine';
import type { Context, ILogger } from 'pulse-coder-engine';
import type { TeammateOptions, TeammateStatus, TeamMessage, EngineOptions } from './types.js';
import type { Mailbox } from './mailbox.js';
import type { TaskList } from './task-list.js';
import { z } from 'zod';

/**
 * A Teammate wraps an independent Engine instance.
 * Each teammate has its own context window, tools, and model config.
 * Teammates communicate via a shared Mailbox and coordinate via a shared TaskList.
 */
export class Teammate {
  readonly id: string;
  readonly name: string;
  readonly spawnPrompt: string;
  readonly requirePlanApproval: boolean;
  readonly cwd: string;

  private engine: Engine;
  private context: Context;
  private _status: TeammateStatus = 'idle';
  private _planMode: boolean;
  private mailbox: Mailbox;
  private taskList: TaskList;
  private logger: ILogger;
  private abortController: AbortController | null = null;
  private onStatusChange?: (id: string, status: TeammateStatus) => void;
  private onOutput?: (id: string, text: string) => void;

  constructor(
    options: TeammateOptions,
    mailbox: Mailbox,
    taskList: TaskList,
    callbacks?: {
      onStatusChange?: (id: string, status: TeammateStatus) => void;
      onOutput?: (id: string, text: string) => void;
    }
  ) {
    this.id = options.id;
    this.name = options.name;
    this.spawnPrompt = options.spawnPrompt || '';
    this.requirePlanApproval = options.requirePlanApproval || false;
    this._planMode = options.requirePlanApproval || false;
    this.cwd = options.cwd || process.cwd();
    this.mailbox = mailbox;
    this.taskList = taskList;
    this.logger = options.logger || console;
    this.onStatusChange = callbacks?.onStatusChange;
    this.onOutput = callbacks?.onOutput;

    // Create independent Engine instance with teammate-specific config
    const cwdTools = this.buildCwdTools(options.engineOptions?.tools);
    this.engine = new Engine({
      ...options.engineOptions,
      model: options.model || options.engineOptions?.model,
      logger: this.logger,
      // Inject team-aware tools (cwd-wrapped tools + team tools)
      tools: {
        ...options.engineOptions?.tools,
        ...cwdTools,
        ...this.buildTeamTools(),
      },
    });

    // Initialize empty context
    this.context = { messages: [] };
  }

  get status(): TeammateStatus {
    return this._status;
  }

  get planMode(): boolean {
    return this._planMode;
  }

  /**
   * Initialize the teammate's engine.
   */
  async initialize(): Promise<void> {
    await this.engine.initialize();
  }

  /**
   * Run the teammate with a task prompt.
   * The teammate will execute until done or stopped.
   */
  async run(prompt: string): Promise<string> {
    this.setStatus('running');
    this.abortController = new AbortController();

    // Build system context
    const planModeInstructions = this._planMode
      ? '\n\nIMPORTANT: You are in PLAN MODE. You must only read and analyze — do NOT make any changes. ' +
        'When you have a plan ready, use the team_submit_plan tool to send it to the lead for approval. ' +
        'Wait for approval before making any changes.'
      : '';

    const cwdNote = this.cwd !== process.cwd()
      ? `\n## Working Directory\nYour working directory is: ${this.cwd}\n- For \`bash\`, always pass cwd: "${this.cwd}" unless you need a different directory.\n- For \`grep\` and \`ls\`, pass path: "${this.cwd}" as the base path.\n- For \`read\`, \`write\`, and \`edit\`, use absolute paths under "${this.cwd}".\n`
      : '';

    const toolGuidance = `
## Tool Usage Rules
- To search code, use the \`grep\` tool (NOT bash + rg/grep). The grep tool handles pattern escaping automatically.
- To read files, use the \`read\` tool. To list directories, use \`ls\`. To modify files, use \`edit\` or \`write\`.
- Only use \`bash\` for commands that have no dedicated tool (e.g. git, npm, build commands).
- NEVER type bare keywords as bash commands. \`bash("auth")\` does NOT search for "auth" — use \`grep({ pattern: "auth" })\` instead.
${cwdNote}`;

    const systemContext = this.spawnPrompt
      ? `You are a teammate in an agent team. Your role: ${this.name}\n\nSpawn instructions:\n${this.spawnPrompt}${planModeInstructions}\n${toolGuidance}\n`
      : `You are a teammate in an agent team. Your role: ${this.name}${planModeInstructions}\n${toolGuidance}\n`;

    // Process any pending messages and prepend them to the prompt
    const pendingMessages = this.mailbox.readUnread(this.id);
    let messagesContext = '';
    if (pendingMessages.length > 0) {
      messagesContext = '\n\n--- Unread messages ---\n' +
        pendingMessages.map(m => `[from: ${m.from}] (${m.type}) ${m.content}`).join('\n') +
        '\n--- End messages ---\n\n';
    }

    this.context.messages.push({
      role: 'user',
      content: messagesContext + prompt,
    });

    let fullOutput = '';

    try {
      const resultText = await this.engine.run(this.context, {
        abortSignal: this.abortController.signal,
        systemPrompt: systemContext,
        onText: (delta) => {
          fullOutput += delta;
          this.onOutput?.(this.id, delta);
        },
        onCompacted: (newMessages) => {
          this.context.messages = newMessages;
        },
        onResponse: (messages) => {
          this.context.messages.push(...messages);
        },
      });

      // Use the result text (engine.run returns string)
      if (!fullOutput && resultText) {
        fullOutput = resultText;
      }

      this.setStatus('idle');
      return fullOutput;
    } catch (err: any) {
      if (err.name === 'AbortError') {
        this.setStatus('stopped');
        return fullOutput;
      }
      this.logger.error(`Teammate ${this.name} error`, err);
      this.setStatus('idle');
      throw err;
    }
  }

  /**
   * Send a message to another teammate.
   */
  sendMessage(toId: string, content: string): TeamMessage {
    return this.mailbox.send(this.id, toId, 'message', content);
  }

  /**
   * Read unread messages.
   * When `peek` is true, messages are returned but stay marked as unread
   * so they can still be consumed later (e.g. inside `run()`).
   */
  readMessages(options?: { peek?: boolean }): TeamMessage[] {
    return this.mailbox.readUnread(this.id, options);
  }

  /**
   * Check if there's a plan approval response and handle it.
   * Uses peek so that non-approval messages stay unread for `run()` to consume.
   * Returns true if plan was approved.
   */
  checkPlanApproval(): { approved: boolean; feedback?: string } | null {
    const messages = this.mailbox.readUnread(this.id, { peek: true });
    for (const msg of messages) {
      if (msg.type === 'plan_approval_response') {
        try {
          const response = JSON.parse(msg.content);
          if (response.approved) {
            this._planMode = false;
          }
          // Only mark this specific approval message as read
          this.mailbox.markAsRead(this.id, [msg.id]);
          return response;
        } catch {
          // Malformed response
        }
      }
    }
    return null;
  }

  /**
   * Request shutdown gracefully.
   */
  async requestShutdown(): Promise<void> {
    this.setStatus('stopping');
    if (this.abortController) {
      this.abortController.abort();
    }
    this.setStatus('stopped');
  }

  /**
   * Claim an available task from the shared task list.
   */
  async claimTask(taskId?: string) {
    return this.taskList.claim(this.id, taskId);
  }

  /**
   * Complete a task.
   */
  async completeTask(taskId: string, result?: string) {
    return this.taskList.complete(taskId, result);
  }

  /**
   * Fail a task.
   */
  async failTask(taskId: string, error?: string) {
    return this.taskList.fail(taskId, error);
  }

  /**
   * Get the teammate's conversation context (for debugging/display).
   */
  getContext(): Context {
    return { messages: [...this.context.messages] };
  }

  /**
   * Get the number of turns in the conversation.
   */
  get turnCount(): number {
    return this.context.messages.filter(m => m.role === 'assistant').length;
  }

  // ─── CWD-aware tool wrappers ──────────────────────────────────────

  /**
   * Build tool overrides that default `cwd` for bash and `path` for grep/ls.
   * Only creates wrappers when cwd differs from process.cwd().
   */
  private buildCwdTools(existingTools?: Record<string, any>): Record<string, any> {
    if (this.cwd === process.cwd()) return {};

    const teammateCwd = this.cwd;
    const overrides: Record<string, any> = {};

    // Wrap bash: default cwd to teammate's working directory
    overrides.bash = {
      name: 'bash',
      description: 'Execute a bash command. Working directory defaults to the teammate\'s configured cwd.',
      inputSchema: z.object({
        command: z.string().describe('The command to execute'),
        timeout: z.number().optional().describe('Timeout in ms (default 120000)'),
        cwd: z.string().optional().describe(`Working directory (default: ${teammateCwd})`),
        description: z.string().optional().describe('Description of the command'),
      }),
      execute: async (input: { command: string; timeout?: number; cwd?: string; description?: string }) => {
        const { execSync } = await import('child_process');
        const timeout = input.timeout || 120000;
        const cwd = input.cwd || teammateCwd;
        try {
          const output = execSync(input.command, {
            encoding: 'utf-8',
            timeout,
            cwd,
            maxBuffer: 1024 * 1024 * 10,
            shell: '/bin/bash',
          });
          return output;
        } catch (err: any) {
          if (err.killed) throw new Error(`Command timed out after ${timeout}ms`);
          const stderr = err.stderr || '';
          const stdout = err.stdout || '';
          throw new Error(`Command failed (exit ${err.status}): ${stderr || stdout || err.message}`);
        }
      },
    };

    return overrides;
  }

  // ─── Team-aware tools ────────────────────────────────────────────

  /**
   * Build tools that give the teammate access to team capabilities.
   */
  private buildTeamTools() {
    const teammate = this;

    const tools: Record<string, any> = {
      team_send_message: {
        name: 'team_send_message',
        description: 'Send a message to another teammate by their ID.',
        inputSchema: z.object({
          to: z.string().describe('Recipient teammate ID'),
          content: z.string().describe('Message content'),
        }),
        execute: async (input: { to: string; content: string }) => {
          const msg = teammate.mailbox.send(teammate.id, input.to, 'message', input.content);
          return `Message sent to ${input.to} (id: ${msg.id})`;
        },
      },
      team_read_messages: {
        name: 'team_read_messages',
        description: 'Read unread messages from the team mailbox.',
        inputSchema: z.object({}),
        execute: async () => {
          const messages = teammate.mailbox.readUnread(teammate.id);
          if (messages.length === 0) return 'No unread messages.';
          return messages.map(m => `[from: ${m.from}] (${m.type}) ${m.content}`).join('\n---\n');
        },
      },
      team_list_tasks: {
        name: 'team_list_tasks',
        description: 'List all tasks in the shared task list with their status and assignee.',
        inputSchema: z.object({}),
        execute: async () => {
          const tasks = teammate.taskList.getAll();
          if (tasks.length === 0) return 'No tasks.';
          return tasks.map(t =>
            `[${t.status}] ${t.title} (id: ${t.id}, assignee: ${t.assignee || 'none'})`
          ).join('\n');
        },
      },
      team_claim_task: {
        name: 'team_claim_task',
        description: 'Claim an available pending task. Optionally specify a task ID, or auto-claim the next available one.',
        inputSchema: z.object({
          taskId: z.string().optional().describe('Specific task ID to claim, or omit for auto-claim'),
        }),
        execute: async (input: { taskId?: string }) => {
          const task = await teammate.claimTask(input.taskId);
          if (!task) return 'No claimable task available.';
          return `Claimed task: ${task.title} (id: ${task.id})\nDescription: ${task.description}`;
        },
      },
      team_complete_task: {
        name: 'team_complete_task',
        description: 'Mark a task as completed with an optional result summary.',
        inputSchema: z.object({
          taskId: z.string().describe('Task ID to complete'),
          result: z.string().optional().describe('Task result or summary'),
        }),
        execute: async (input: { taskId: string; result?: string }) => {
          const task = await teammate.completeTask(input.taskId, input.result);
          if (!task) return 'Task not found or not in progress.';
          return `Task completed: ${task.title}`;
        },
      },
      team_create_task: {
        name: 'team_create_task',
        description: 'Create a new task in the shared task list.',
        inputSchema: z.object({
          title: z.string().describe('Short task title'),
          description: z.string().describe('Detailed description'),
          deps: z.array(z.string()).optional().describe('IDs of dependency tasks'),
          assignee: z.string().optional().describe('Teammate ID to assign to'),
        }),
        execute: async (input: { title: string; description: string; deps?: string[]; assignee?: string }) => {
          const task = await teammate.taskList.create(input, teammate.id);
          return `Task created: ${task.title} (id: ${task.id})`;
        },
      },
      team_notify_lead: {
        name: 'team_notify_lead',
        description: 'Send a message to the team lead (e.g. to report findings, ask questions, or signal completion).',
        inputSchema: z.object({
          content: z.string().describe('Message to the lead'),
        }),
        execute: async (input: { content: string }) => {
          teammate.mailbox.send(teammate.id, 'lead', 'message', input.content);
          return 'Message sent to lead.';
        },
      },
    };

    // Add plan-mode specific tools
    if (teammate.requirePlanApproval) {
      tools.team_submit_plan = {
        name: 'team_submit_plan',
        description: 'Submit your plan to the lead for approval. Use this when you have finished planning and want to proceed.',
        inputSchema: z.object({
          plan: z.string().describe('Your detailed implementation plan'),
        }),
        execute: async (input: { plan: string }) => {
          teammate.mailbox.send(
            teammate.id,
            'lead',
            'plan_approval_request',
            input.plan,
          );
          return 'Plan submitted to lead for approval. Waiting for response...';
        },
      };
    }

    return tools;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private setStatus(status: TeammateStatus): void {
    this._status = status;
    this.onStatusChange?.(this.id, status);
  }
}
