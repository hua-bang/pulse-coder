import type { Context, ILogger } from 'pulse-coder-engine';
import type { TeammateOptions, TeammateStatus, TeamMessage } from './types.js';
import type { Mailbox } from './mailbox.js';
import type { TaskList } from './task-list.js';
import type {
  AgentRuntime,
  AgentRuntimeFactory,
  RuntimeContext,
} from './runtimes/types.js';
import { PulseRuntime } from './runtimes/pulse-runtime.js';

/**
 * A Teammate wraps an independent AgentRuntime instance.
 * Each teammate has its own context window, tools, and (optionally) backend.
 * Teammates communicate via a shared Mailbox and coordinate via a shared TaskList.
 */
export class Teammate {
  readonly id: string;
  readonly name: string;
  readonly spawnPrompt: string;
  readonly requirePlanApproval: boolean;
  readonly cwd: string;

  private runtime: AgentRuntime;
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
    },
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

    const runtimeCtx: RuntimeContext = {
      teammateId: this.id,
      teammateName: this.name,
      cwd: this.cwd,
      mailbox,
      taskList,
      stateDir: options.stateDir,
      requirePlanApproval: this.requirePlanApproval,
      logger: this.logger,
    };

    const factory: AgentRuntimeFactory =
      options.runtime ??
      ((ctx) =>
        new PulseRuntime(ctx, {
          engineOptions: options.engineOptions,
          model: options.model,
        }));
    this.runtime = factory(runtimeCtx);
  }

  get status(): TeammateStatus {
    return this._status;
  }

  get planMode(): boolean {
    return this._planMode;
  }

  /**
   * Initialize the teammate's runtime.
   */
  async initialize(): Promise<void> {
    await this.runtime.initialize();
  }

  /**
   * Run the teammate with a task prompt.
   * The teammate will execute until done or stopped.
   */
  async run(prompt: string): Promise<string> {
    this.setStatus('running');
    this.abortController = new AbortController();

    const planModeInstructions = this._planMode
      ? '\n\nIMPORTANT: You are in PLAN MODE. You must only read and analyze — do NOT make any changes. ' +
        'When you have a plan ready, use the team_submit_plan tool to send it to the lead for approval. ' +
        'Wait for approval before making any changes.'
      : '';

    const cwdNote =
      this.cwd !== process.cwd()
        ? `\n## Working Directory\nYour working directory is: ${this.cwd}\n- For \`bash\`, always pass cwd: "${this.cwd}" unless you need a different directory.\n- For \`grep\` and \`ls\`, pass path: "${this.cwd}" as the base path.\n- For \`read\`, \`write\`, and \`edit\`, use absolute paths under "${this.cwd}".\n`
        : '';

    const toolGuidance = `
## Tool Usage Rules
- To search code, use the \`grep\` tool (NOT bash + rg/grep). The grep tool handles pattern escaping automatically.
- To read files, use the \`read\` tool. To list directories, use \`ls\`. To modify files, use \`edit\` or \`write\`.
- Only use \`bash\` for commands that have no dedicated tool (e.g. git, npm, build commands).
- NEVER type bare keywords as bash commands. \`bash("auth")\` does NOT search for "auth" — use \`grep({ pattern: "auth" })\` instead.
${cwdNote}`;

    const systemPrompt = this.spawnPrompt
      ? `You are a teammate in an agent team. Your role: ${this.name}\n\nSpawn instructions:\n${this.spawnPrompt}${planModeInstructions}\n${toolGuidance}\n`
      : `You are a teammate in an agent team. Your role: ${this.name}${planModeInstructions}\n${toolGuidance}\n`;

    // Surface any pending messages at the head of the next prompt so the
    // backend (whichever it is) can react to them.
    const pendingMessages = this.mailbox.readUnread(this.id);
    let messagesContext = '';
    if (pendingMessages.length > 0) {
      messagesContext =
        '\n\n--- Unread messages ---\n' +
        pendingMessages
          .map((m) => `[from: ${m.from}] (${m.type}) ${m.content}`)
          .join('\n') +
        '\n--- End messages ---\n\n';
    }

    let fullOutput = '';
    try {
      const result = await this.runtime.run({
        prompt: messagesContext + prompt,
        systemPrompt,
        abortSignal: this.abortController.signal,
        onText: (delta) => {
          fullOutput += delta;
          this.onOutput?.(this.id, delta);
        },
      });
      this.setStatus('idle');
      return fullOutput || result;
    } catch (err: any) {
      if (err?.name === 'AbortError' || this.abortController.signal.aborted) {
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
   */
  readMessages(): TeamMessage[] {
    return this.mailbox.readUnread(this.id);
  }

  /**
   * Check if there's a plan approval response and handle it.
   * Returns true if plan was approved.
   */
  checkPlanApproval(): { approved: boolean; feedback?: string } | null {
    const messages = this.mailbox.readUnread(this.id);
    for (const msg of messages) {
      if (msg.type === 'plan_approval_response') {
        try {
          const response = JSON.parse(msg.content);
          if (response.approved) {
            this._planMode = false;
          }
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
    this.abortController?.abort();
    try {
      await this.runtime.shutdown?.();
    } catch (err) {
      this.logger.error(`Teammate ${this.name} shutdown error`, err as Error);
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
   * Get the teammate's conversation context (pulse runtime only).
   * Returns an empty context for non-pulse runtimes — those keep state inside
   * their own CLI process and surface it via streaming events instead.
   */
  getContext(): Context {
    if (this.runtime instanceof PulseRuntime) {
      return this.runtime.getContext();
    }
    return { messages: [] };
  }

  /** Number of assistant turns recorded (pulse runtime only). */
  get turnCount(): number {
    return this.runtime instanceof PulseRuntime ? this.runtime.turnCount : 0;
  }

  /** Backend kind, exposed for canvases / UIs that want to badge the teammate. */
  get runtimeKind(): AgentRuntime['kind'] {
    return this.runtime.kind;
  }

  // ─── Internal ────────────────────────────────────────────────────

  private setStatus(status: TeammateStatus): void {
    this._status = status;
    this.onStatusChange?.(this.id, status);
  }
}
