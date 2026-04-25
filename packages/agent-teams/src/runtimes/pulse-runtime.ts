import { Engine } from 'pulse-coder-engine';
import type { Context, ILogger } from 'pulse-coder-engine';
import { z } from 'zod';
import { createPulseTeamTools } from '../team-tools.js';
import type { EngineOptions } from '../types.js';
import type { AgentRuntime, RuntimeContext, RuntimeRunOptions } from './types.js';

export interface PulseRuntimeOptions {
  /** Engine configuration for this teammate's independent Engine instance. */
  engineOptions?: EngineOptions;
  /** Model override. */
  model?: string;
}

/**
 * In-process pulse-coder-engine runtime.
 * Equivalent to the original Teammate behavior — kept here so Teammate stays
 * runtime-agnostic.
 */
export class PulseRuntime implements AgentRuntime {
  readonly kind = 'pulse' as const;

  private engine: Engine;
  private context: Context = { messages: [] };
  private logger: ILogger;

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly options: PulseRuntimeOptions = {},
  ) {
    this.logger = ctx.logger || console;
    const cwdTools = this.buildCwdTools(options.engineOptions?.tools);
    const teamTools = createPulseTeamTools({
      teammateId: ctx.teammateId,
      mailbox: ctx.mailbox,
      taskList: ctx.taskList,
      requirePlanApproval: ctx.requirePlanApproval,
    });

    this.engine = new Engine({
      ...options.engineOptions,
      model: options.model || options.engineOptions?.model,
      logger: this.logger,
      tools: {
        ...options.engineOptions?.tools,
        ...cwdTools,
        ...teamTools,
      },
    });
  }

  async initialize(): Promise<void> {
    await this.engine.initialize();
  }

  async run(opts: RuntimeRunOptions): Promise<string> {
    this.context.messages.push({ role: 'user', content: opts.prompt });

    let fullOutput = '';
    const result = await this.engine.run(this.context, {
      abortSignal: opts.abortSignal,
      systemPrompt: opts.systemPrompt,
      onText: (delta) => {
        fullOutput += delta;
        opts.onText?.(delta);
      },
      onCompacted: (newMessages) => {
        this.context.messages = newMessages;
      },
      onResponse: (messages) => {
        this.context.messages.push(...messages);
      },
    });

    return fullOutput || result || '';
  }

  /** Expose the underlying message log so Teammate can surface it for debugging. */
  getContext(): Context {
    return { messages: [...this.context.messages] };
  }

  /** Number of assistant turns recorded so far. */
  get turnCount(): number {
    return this.context.messages.filter((m) => m.role === 'assistant').length;
  }

  /**
   * Build tool overrides that default `cwd` for bash when the teammate's cwd
   * differs from the host process. Mirrors the original Teammate.buildCwdTools.
   */
  private buildCwdTools(
    existingTools?: Record<string, any>,
  ): Record<string, any> {
    void existingTools;
    if (this.ctx.cwd === process.cwd()) return {};

    const teammateCwd = this.ctx.cwd;
    return {
      bash: {
        name: 'bash',
        description:
          "Execute a bash command. Working directory defaults to the teammate's configured cwd.",
        inputSchema: z.object({
          command: z.string().describe('The command to execute'),
          timeout: z.number().optional().describe('Timeout in ms (default 120000)'),
          cwd: z
            .string()
            .optional()
            .describe(`Working directory (default: ${teammateCwd})`),
          description: z.string().optional().describe('Description of the command'),
        }),
        execute: async (input: {
          command: string;
          timeout?: number;
          cwd?: string;
          description?: string;
        }) => {
          const { execSync } = await import('node:child_process');
          const timeout = input.timeout || 120000;
          const cwd = input.cwd || teammateCwd;
          try {
            return execSync(input.command, {
              encoding: 'utf-8',
              timeout,
              cwd,
              maxBuffer: 1024 * 1024 * 10,
              shell: '/bin/bash',
            });
          } catch (err: any) {
            if (err.killed) throw new Error(`Command timed out after ${timeout}ms`);
            const stderr = err.stderr || '';
            const stdout = err.stdout || '';
            throw new Error(
              `Command failed (exit ${err.status}): ${stderr || stdout || err.message}`,
            );
          }
        },
      },
    };
  }
}
