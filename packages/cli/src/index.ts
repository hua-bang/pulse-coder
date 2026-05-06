import { PulseAgent } from 'pulse-coder-engine';
import { createJsExecutor, createRunJsTool } from 'pulse-sandbox/src';
import * as readline from 'readline';
import type { Context, TaskListService } from 'pulse-coder-engine';
import { getAcpState, runAcp } from 'pulse-coder-acp';
import { SessionCommands } from './session-commands.js';
import { InputManager } from './input-manager.js';
import { SkillCommands } from './skill-commands.js';
import { runTeam, TeamsSession } from './team-commands.js';
import { memoryIntegration, buildMemoryRunContext, recordDailyLogFromSuccessPath } from './memory-integration.js';
import { ACP_CLIENT_INFO, handleAcpCommand, resolveAcpPlatformKey } from './acp-commands.js';
import { TuiRenderer, type TuiHelpItem } from './tui-renderer.js';
import { resolveCliUiMode } from './ui-mode.js';

const LOCAL_COMMANDS = new Set([
  'help',
  'new',
  'resume',
  'sessions',
  'search',
  'rename',
  'delete',
  'clear',
  'compact',
  'skills',
  'wt',
  'acp',
  'status',
  'mode',
  'plan',
  'execute',
  'team',
  'teams',
  'solo',
  'save',
  'tui',
  'exit',
]);

const HELP_ITEMS: TuiHelpItem[] = [
  { command: '/help', description: 'Show this help message' },
  { command: '/new [title]', description: 'Create a new session' },
  { command: '/resume <id>', description: 'Resume a saved session' },
  { command: '/sessions', description: 'List all saved sessions' },
  { command: '/search <query>', description: 'Search in saved sessions' },
  { command: '/rename <id> <new-title>', description: 'Rename a session' },
  { command: '/delete <id>', description: 'Delete a session' },
  { command: '/clear', description: 'Clear current conversation' },
  { command: '/compact', description: 'Force compact current conversation context' },
  { command: '/skills [list|<name|index> <message>]', description: 'Run one message with a selected skill' },
  { command: '/acp [status|on|off|cd]', description: 'Manage ACP mode for this CLI' },
  { command: '/wt use <work-name>', description: 'Create a worktree + branch via worktree skill' },
  { command: '/status', description: 'Show current session status' },
  { command: '/mode', description: 'Show current plan mode' },
  { command: '/plan', description: 'Switch to planning mode' },
  { command: '/execute', description: 'Switch to executing mode' },
  { command: '/team <task>', description: 'Run a multi-agent team (LLM plans DAG by default)' },
  { command: '/team --route=auto <task>', description: 'Use keyword-based routing instead of LLM planning' },
  { command: '/teams <task>', description: 'Run agent teams (enters teams mode for follow-ups)' },
  { command: '/teams <task> --concurrency N', description: 'Limit parallel teammates' },
  { command: '/teams <task> --cwd <dir>', description: 'Set working directory for teammates' },
  { command: '/solo', description: 'Exit teams mode, return to normal agent' },
  { command: '/save', description: 'Save current session explicitly' },
  { command: '/tui [on|off|status]', description: 'Toggle or inspect the interactive TUI renderer' },
  { command: '/exit', description: 'Exit the application' },
];

const HELP_FOOTER = [
  'Esc (while processing) - Stop current response and accept next input',
  'Ctrl+C - Exit CLI immediately',
];

class CoderCLI {
  private agent: PulseAgent;
  private context: Context;
  private sessionCommands: SessionCommands;
  private inputManager: InputManager;
  private skillCommands: SkillCommands;
  private acpPlatformKey: string;
  private tui: TuiRenderer;

  constructor() {
    const runJsTool = createRunJsTool({
      executor: createJsExecutor()
    });

    // 🎯 现在引擎自动包含内置插件，无需显式配置！
    this.agent = new PulseAgent({
      enginePlugins: {
        plugins: [memoryIntegration.enginePlugin],
        // 只配置扩展插件目录，内置插件会自动加载
        dirs: ['.pulse-coder/engine-plugins', '.coder/engine-plugins', '~/.pulse-coder/engine-plugins', '~/.coder/engine-plugins'],
        scan: true
      },
      userConfigPlugins: {
        dirs: ['.pulse-coder/config', '.coder/config', '~/.pulse-coder/config', '~/.coder/config'],
        scan: true
      },
      tools: {
        [runJsTool.name]: runJsTool
      }
      // 注意：不再需要 plugins: [...] 配置
    });
    this.context = { messages: [] };
    this.sessionCommands = new SessionCommands();
    this.inputManager = new InputManager();
    this.skillCommands = new SkillCommands(this.agent);
    this.acpPlatformKey = resolveAcpPlatformKey();
    this.tui = new TuiRenderer();
  }

  private safeStringify(value: unknown): string {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private estimateTokens(messages: Context['messages']): number {
    let totalChars = 0;

    for (const message of messages) {
      totalChars += message.role.length;
      if (typeof message.content === 'string') {
        totalChars += message.content.length;
      } else {
        totalChars += this.safeStringify(message.content).length;
      }
    }

    return Math.ceil(totalChars / 4);
  }

  private getKeepLastTurns(): number {
    const value = Number(process.env.KEEP_LAST_TURNS ?? 4);
    if (!Number.isFinite(value) || value <= 0) {
      return 4;
    }

    return Math.floor(value);
  }


  private resolveCurrentSessionId(): string | null {
    const currentId = this.sessionCommands.getCurrentSessionId();
    if (currentId) {
      return currentId;
    }

    this.tui.warn('No active session ID; memory tools and daily logs are skipped for this run.');
    return null;
  }

  private async syncSessionTaskListBinding(): Promise<void> {
    const taskListId = this.sessionCommands.getCurrentTaskListId();
    if (!taskListId) {
      return;
    }

    process.env.PULSE_CODER_TASK_LIST_ID = taskListId;

    const service = this.agent.getService<TaskListService>('taskListService');
    if (!service?.setTaskListId) {
      return;
    }

    try {
      const result = await service.setTaskListId(taskListId);
      if (result.switched) {
        this.tui.success(`Switched task list to ${result.taskListId}`);
      }
    } catch (error: any) {
      this.tui.warn(`Failed to switch task list binding: ${error?.message ?? String(error)}`);
    }
  }

  private async handleCommand(command: string, args: string[]): Promise<void> {
    try {
      switch (command.toLowerCase()) {
        case 'help':
          this.tui.showHelp(HELP_ITEMS, HELP_FOOTER);
          break;

        case 'new':
          const newTitle = args.join(' ') || undefined;
          await this.sessionCommands.createSession(newTitle);
          this.context.messages = [];
          await this.syncSessionTaskListBinding();
          break;

        case 'resume':
          if (args.length === 0) {
            this.tui.error('Please provide a session ID');
            this.tui.info('Usage: /resume <session-id>');
            break;
          }
          const sessionId = args[0];
          const success = await this.sessionCommands.resumeSession(sessionId);
          if (success) {
            await this.sessionCommands.loadContext(this.context);
            await this.syncSessionTaskListBinding();
          }
          break;

        case 'sessions':
          await this.sessionCommands.listSessions();
          break;

        case 'search':
          if (args.length === 0) {
            this.tui.error('Please provide a search query');
            this.tui.info('Usage: /search <query>');
            break;
          }
          const query = args.join(' ');
          await this.sessionCommands.searchSessions(query);
          break;

        case 'rename':
          if (args.length < 2) {
            this.tui.error('Please provide session ID and new title');
            this.tui.info('Usage: /rename <session-id> <new-title>');
            break;
          }
          const renameId = args[0];
          const newName = args.slice(1).join(' ');
          await this.sessionCommands.renameSession(renameId, newName);
          break;

        case 'delete':
          if (args.length === 0) {
            this.tui.error('Please provide a session ID');
            this.tui.info('Usage: /delete <session-id>');
            break;
          }
          const deleteId = args[0];
          await this.sessionCommands.deleteSession(deleteId);
          break;

        case 'clear':
          this.context.messages = [];
          this.tui.success('Current conversation cleared!');
          break;

        case 'compact':
          if (this.context.messages.length === 0) {
            this.tui.info('Context is empty, nothing to compact.');
            break;
          }

          const beforeCount = this.context.messages.length;
          const beforeTokens = this.estimateTokens(this.context.messages);
          const keepLastTurns = this.getKeepLastTurns();
          const compactResult = await this.agent.compactContext(this.context, { force: true });

          if (!compactResult.didCompact || !compactResult.newMessages) {
            this.tui.info('No compaction was applied.');
            this.tui.plain(`Messages: ${beforeCount}, estimated tokens: ~${beforeTokens}, KEEP_LAST_TURNS=${keepLastTurns}`);
            break;
          }

          this.context.messages = compactResult.newMessages;
          await this.sessionCommands.saveContext(this.context);

          const afterCount = this.context.messages.length;
          const afterTokens = this.estimateTokens(this.context.messages);
          const tokenDelta = beforeTokens - afterTokens;
          const tokenDeltaText = tokenDelta >= 0 ? `-${tokenDelta}` : `+${Math.abs(tokenDelta)}`;
          const reasonSuffix = compactResult.reason ? ` (${compactResult.reason})` : '';

          this.tui.section(`Context compacted${reasonSuffix}`, [
            `Messages: ${beforeCount} -> ${afterCount}`,
            `Estimated tokens: ~${beforeTokens} -> ~${afterTokens} (${tokenDeltaText})`,
            `KEEP_LAST_TURNS=${keepLastTurns}`,
          ]);
          break;

        case 'skills':
          this.tui.info('Use /skills <name|index> <message> directly in input for one-shot skill execution.');
          break;

        case 'acp': {
          const message = await handleAcpCommand(this.acpPlatformKey, args);
          this.tui.plain(`\n${message}`);
          break;
        }

        case 'status':
          const currentId = this.sessionCommands.getCurrentSessionId();
          const currentTaskListId = this.sessionCommands.getCurrentTaskListId();
          this.tui.section('Session Status', [
            `Current Session: ${currentId || 'None (new session)'}`,
            `Task List: ${currentTaskListId || 'None'}`,
            `Messages: ${this.context.messages.length}`,
            ...(currentId ? ['To save this session, use: /save'] : []),
          ]);
          break;

        case 'mode':
          const currentMode = this.agent.getMode();
          if (!currentMode) {
            this.tui.warn('plan mode plugin unavailable');
            break;
          }

          this.tui.info(`Current mode: ${currentMode}`);
          break;

        case 'plan':
          if (this.agent.setMode('planning', 'cli:/plan')) {
            this.tui.success('Switched to planning mode');
          } else {
            this.tui.error('Failed to switch mode: plan mode plugin unavailable');
          }
          break;

        case 'execute':
          if (this.agent.setMode('executing', 'cli:/execute')) {
            this.tui.success('Switched to executing mode');
          } else {
            this.tui.error('Failed to switch mode: plan mode plugin unavailable');
          }
          break;

        case 'tui': {
          const action = (args[0] ?? 'status').toLowerCase();
          if (action === 'on') {
            if (this.tui.setEnabled(true)) {
              this.tui.success('TUI enabled for this process.');
            } else {
              this.tui.warn('TUI is not available in this terminal. Staying in plain mode.');
            }
          } else if (action === 'off') {
            this.tui.setEnabled(false);
            this.tui.info('TUI disabled for this process.');
          } else if (action === 'status') {
            this.tui.showTuiStatus();
          } else {
            this.tui.warn('Usage: /tui [on|off|status]');
          }
          break;
        }

        case 'save':
          if (this.sessionCommands.getCurrentSessionId()) {
            await this.sessionCommands.saveContext(this.context);
            this.tui.success('Current session saved!');
          } else {
            this.tui.error('No active session. Create one with /new');
          }
          break;

        case 'exit':
          this.tui.info('Saving current session...');
          await this.sessionCommands.saveContext(this.context);
          this.tui.success('Goodbye!');
          process.exit(0);
          break;

        default:
          this.tui.warn(`Unknown command: ${command}`);
          this.tui.info('Type /help to see available commands');
      }
    } catch (error) {
      this.tui.error(`Error executing command: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async start() {
    this.tui.showWelcome();

    await this.sessionCommands.initialize();
    await memoryIntegration.initialize();
    await this.agent.initialize();

    // 显示插件状态
    const pluginStatus = this.agent.getPluginStatus();
    this.tui.showPluginStatus(pluginStatus.enginePlugins.length);

    // Auto-create a new session
    await this.sessionCommands.createSession();
    await this.syncSessionTaskListBinding();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: this.tui.prompt()
    });

    let currentAbortController: AbortController | null = null;
    let isProcessing = false;
    const queuedInputs: string[] = [];
    let teamsSession: TeamsSession | null = null;

    readline.emitKeypressEvents(process.stdin);

    const requestStopCurrentRun = (): boolean => {
      if (isProcessing) {
        if (currentAbortController && !currentAbortController.signal.aborted) {
          currentAbortController.abort();
          this.tui.abort('Request cancelled by Esc. You can type the next message now.');
        } else {
          this.tui.abort('Cancellation already requested. Waiting for current step to finish...');
        }
        rl.prompt();
        return true;
      }

      if (this.inputManager.hasPendingRequest()) {
        this.inputManager.cancel('User interrupted with Esc');
        this.tui.abort('Clarification cancelled.');
        rl.prompt();
        return true;
      }

      return false;
    };

    const onKeypress = (_char: string, key: readline.Key) => {
      if (key?.name === 'escape') {
        requestStopCurrentRun();
      }
    };

    process.stdin.on('keypress', onKeypress);

    // Handle SIGINT gracefully
    process.on('SIGINT', () => {
      process.stdin.off('keypress', onKeypress);

      if (isProcessing && currentAbortController && !currentAbortController.signal.aborted) {
        currentAbortController.abort();
      }

      if (this.inputManager.hasPendingRequest()) {
        this.inputManager.cancel('User interrupted with Ctrl+C');
      }

      this.tui.info('Saving current session...');
      const cleanupTeams = teamsSession?.active ? teamsSession.stop().catch(() => {}) : Promise.resolve();
      cleanupTeams.then(() => this.sessionCommands.saveContext(this.context)).finally(() => {
        this.tui.success('Goodbye!');
        process.exit(0);
      });
    });

    // Main input handler
    const handleInput = async (input: string) => {
      const trimmedInput = input.trim();

      // Handle clarification requests first
      if (this.inputManager.handleUserInput(trimmedInput)) {
        return;
      }

      if (isProcessing) {
        if (currentAbortController?.signal.aborted) {
          if (!trimmedInput) {
            rl.prompt();
            return;
          }

          queuedInputs.push(trimmedInput);
          this.tui.queued('Input queued. It will run right after the current step finishes.');
          rl.prompt();
          return;
        }

        this.tui.warn('Still processing. Press Esc to stop current request first.');
        rl.prompt();
        return;
      }

      if (trimmedInput.toLowerCase() === 'exit') {
        this.tui.info('Saving current session...');
        await this.sessionCommands.saveContext(this.context);
        this.tui.success('Goodbye!');
        rl.close();
        return;
      }

      if (!trimmedInput) {
        rl.prompt();
        return;
      }

      let messageInput = trimmedInput;
      let forceAcp = false;

      if (trimmedInput.startsWith('//')) {
        const acpState = await getAcpState(this.acpPlatformKey);
        if (!acpState) {
          this.tui.warn('ACP 未启用，请先使用 /acp on <claude|codex>。');
          rl.prompt();
          return;
        }
        messageInput = trimmedInput.slice(1);
        forceAcp = true;
      }

      // Handle commands
      if (messageInput.startsWith('/') && !forceAcp) {
        const commandLine = messageInput.substring(1);
        const parts = commandLine.split(/\s+/).filter(part => part.length > 0);

        if (parts.length === 0) {
          this.tui.warn('Please provide a command after "/"');
          rl.prompt();
          return;
        }

        const command = parts[0];
        const args = parts.slice(1);
        const normalizedCommand = command.toLowerCase();

        if (normalizedCommand === 'acp') {
          await this.handleCommand(command, args);
          rl.prompt();
          return;
        }

        if (!LOCAL_COMMANDS.has(normalizedCommand)) {
          const acpState = await getAcpState(this.acpPlatformKey);
          if (acpState) {
            forceAcp = true;
          } else {
            this.tui.warn(`Unknown command: /${command}`);
            this.tui.info('Type /help to see available commands');
            rl.prompt();
            return;
          }
        }

        if (!forceAcp) {
          if (normalizedCommand === 'team') {
            isProcessing = true;
            try {
              await runTeam(this.agent, args);
            } finally {
              isProcessing = false;
              rl.prompt();
            }
            return;
          } else if (normalizedCommand === 'teams') {
            isProcessing = true;
            try {
              const session = await TeamsSession.start(args);
              if (session) {
                teamsSession = session;
                rl.setPrompt(this.tui.prompt('teams'));
              }
            } finally {
              isProcessing = false;
              rl.prompt();
            }
            return;
          } else if (normalizedCommand === 'solo') {
            if (teamsSession?.active) {
              isProcessing = true;
              try {
                await teamsSession.stop();
                teamsSession = null;
                rl.setPrompt(this.tui.prompt());
              } finally {
                isProcessing = false;
              }
            } else {
              this.tui.warn('Not in teams mode. Use /teams <task> to start.');
            }
            rl.prompt();
            return;
          } else if (normalizedCommand === 'skills') {
            const transformedMessage = await this.skillCommands.transformSkillsCommandToMessage(args);
            if (!transformedMessage) {
              rl.prompt();
              return;
            }

            messageInput = transformedMessage;
          } else if (normalizedCommand === 'wt') {
            if (args.length < 2 || args[0].toLowerCase() !== 'use') {
              this.tui.error('Usage: /wt use <work-name>');
              rl.prompt();
              return;
            }

            const workName = args.slice(1).join(' ').trim();
            if (!workName) {
              this.tui.error('Worktree name cannot be empty.');
              this.tui.info('Usage: /wt use <work-name>');
              rl.prompt();
              return;
            }

            messageInput = `[use skill](worktree) new ${workName}`;
            this.tui.success('Worktree request prepared via skill: worktree');
          } else {
            await this.handleCommand(command, args);
            rl.prompt();
            return;
          }
        }
      }

      // Teams mode: route plain messages as follow-ups
      if (teamsSession?.active && !forceAcp) {
        isProcessing = true;
        try {
          await teamsSession.followUp(messageInput);
        } catch (err: any) {
          this.tui.error(`Teams follow-up error: ${err.message}`);
        } finally {
          isProcessing = false;
          rl.prompt();
        }
        return;
      }

      // Regular message processing
      this.tui.session({
        sessionId: this.sessionCommands.getCurrentSessionId(),
        taskListId: this.sessionCommands.getCurrentTaskListId(),
        messages: this.context.messages.length,
        estimatedTokens: this.estimateTokens(this.context.messages),
        mode: this.agent.getMode(),
      });

      this.context.messages.push({
        role: 'user',
        content: messageInput,
      });


      this.tui.startProcessing(forceAcp ? 'Running ACP agent' : 'Running agent');

      const ac = new AbortController();
      currentAbortController = ac;
      isProcessing = true;

      let sawText = false;
      let toolCalls = 0;
      const runStartedAt = Date.now();

      const getToolInput = (toolCall: Record<string, unknown>): unknown => {
        const input = (toolCall as { input?: unknown }).input;
        if (input !== undefined) {
          return input;
        }
        const args = (toolCall as { args?: unknown }).args;
        if (args !== undefined) {
          return args;
        }
        return undefined;
      };

      const resolveToolName = (payload: Record<string, unknown>): string => {
        const name = (payload as { toolName?: unknown }).toolName
          ?? (payload as { name?: unknown }).name
          ?? (payload as { tool?: unknown }).tool
          ?? (payload as { title?: unknown }).title
          ?? (payload as { kind?: unknown }).kind;
        if (typeof name === 'string' && name.trim()) {
          return name;
        }
        const toolCallId = (payload as { toolCallId?: unknown }).toolCallId;
        if (typeof toolCallId === 'string' && toolCallId.trim()) {
          return toolCallId;
        }
        return 'tool';
      };

      try {
        await this.syncSessionTaskListBinding();

        const acpState = await getAcpState(this.acpPlatformKey);

        const currentSessionId = this.resolveCurrentSessionId();

        const runAgent = async () => this.agent.run(this.context, {
          abortSignal: ac.signal,
          onText: (delta) => {
            sawText = true;
            this.tui.text(delta);
          },
          onToolCall: (toolCall) => {
            toolCalls += 1;
            const input = getToolInput(toolCall);
            this.tui.toolCall(resolveToolName(toolCall), input);
          },
          onToolResult: (toolResult) => {
            const toolName = resolveToolName(toolResult as Record<string, unknown>);
            this.tui.toolResult(toolName);
          },
          onStepFinish: (step) => {
            this.tui.stepFinished(step.finishReason);
          },
          onClarificationRequest: async (request) => {
            return await this.inputManager.requestInput(request);
          },
          onCompacted: (newMessages) => {
            this.context.messages = newMessages;
          },
          onResponse: (messages) => {
            this.context.messages.push(...messages);
          },
        });
        const runAcpAgent = async () => {
          if (!acpState) {
            return '';
          }
          const result = await runAcp({
            platformKey: this.acpPlatformKey,
            agent: acpState.agent,
            cwd: acpState.cwd,
            sessionId: acpState.sessionId,
            userText: messageInput,
            abortSignal: ac.signal,
            clientInfo: ACP_CLIENT_INFO,
            callbacks: {
              onText: (delta) => {
                sawText = true;
                this.tui.text(delta);
              },
              onToolCall: (toolCall) => {
                toolCalls += 1;
                const input = getToolInput(toolCall);
                this.tui.toolCall(resolveToolName(toolCall), input);
              },
              onToolResult: (toolResult) => {
                const toolName = resolveToolName(toolResult as Record<string, unknown>);
                this.tui.toolResult(toolName);
              },

              onClarificationRequest: async (request) => {
                return await this.inputManager.requestInput(request);
              },
            },
          });
          return result.text;
        };

        const result = currentSessionId
          ? await memoryIntegration.withRunContext(
            buildMemoryRunContext({
              sessionId: currentSessionId,
              userText: messageInput,
            }),
            acpState ? runAcpAgent : runAgent,
          )
          : await (acpState ? runAcpAgent() : runAgent());

        this.tui.runSummary({
          elapsedMs: Date.now() - runStartedAt,
          toolCalls,
          messages: this.context.messages.length,
          estimatedTokens: this.estimateTokens(this.context.messages),
          mode: this.agent.getMode(),
        });

        if (result) {
          if (!sawText) {
            this.tui.plain(result);
          } else {
            this.tui.plain();
          }

          await this.sessionCommands.saveContext(this.context);

          if (currentSessionId) {
            await recordDailyLogFromSuccessPath({
              sessionId: currentSessionId,
              userText: messageInput,
              assistantText: result,
            });
          }
        }
      } catch (error) {
        if (error.name === 'AbortError') {
          this.tui.abort('Operation cancelled.');
        } else {
          this.tui.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
        }
      } finally {
        isProcessing = false;
        currentAbortController = null;

        if (queuedInputs.length > 0) {
          const nextInput = queuedInputs.shift();
          if (nextInput) {
            this.tui.info('Running queued input...');
            setImmediate(() => {
              void handleInput(nextInput);
            });
            return;
          }
        }

        rl.prompt();
      }
    };

    // Start the CLI
    rl.prompt();
    rl.on('line', handleInput);

    // Handle terminal close
    rl.on('close', async () => {
      process.stdin.off('keypress', onKeypress);
      this.tui.info('Saving current session...');
      await this.sessionCommands.saveContext(this.context);
      this.tui.success('Goodbye!');
      process.exit(0);
    });
  }
}

async function main(): Promise<void> {
  if (resolveCliUiMode() === 'ink') {
    const { startInkTui } = await import('./ink-launcher.js');
    await startInkTui();
    return;
  }

  const cli = new CoderCLI();
  await cli.start();
}

main().catch(error => {
  console.error('Failed to start CLI:', error);
  process.exit(1);
});