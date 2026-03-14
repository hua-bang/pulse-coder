import { PulseAgent } from 'pulse-coder-engine';
import { createJsExecutor, createRunJsTool } from 'pulse-sandbox/src';
import * as readline from 'readline';
import type { Context, TaskListService } from 'pulse-coder-engine';
import { getAcpState, runAcp } from 'pulse-coder-acp';
import { SessionCommands } from './session-commands.js';
import { InputManager } from './input-manager.js';
import { SkillCommands } from './skill-commands.js';
import { memoryIntegration, buildMemoryRunContext, recordDailyLogFromSuccessPath } from './memory-integration.js';
import { ACP_CLIENT_INFO, handleAcpCommand, resolveAcpPlatformKey } from './acp-commands.js';

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
  'save',
  'exit',
]);

class CoderCLI {
  private agent: PulseAgent;
  private context: Context;
  private sessionCommands: SessionCommands;
  private inputManager: InputManager;
  private skillCommands: SkillCommands;
  private acpPlatformKey: string;

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

    console.warn('⚠️ No active session ID; memory tools and daily logs are skipped for this run.');
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
        console.log(`🗂️ Switched task list to ${result.taskListId}`);
      }
    } catch (error: any) {
      console.warn(`⚠️ Failed to switch task list binding: ${error?.message ?? String(error)}`);
    }
  }

  private async handleCommand(command: string, args: string[]): Promise<void> {
    try {
      switch (command.toLowerCase()) {
        case 'help':
          console.log('\n📋 Available commands:');
          console.log('/help - Show this help message');
          console.log('/new [title] - Create a new session');
          console.log('/resume <id> - Resume a saved session');
          console.log('/sessions - List all saved sessions');
          console.log('/search <query> - Search in saved sessions');
          console.log('/rename <id> <new-title> - Rename a session');
          console.log('/delete <id> - Delete a session');
          console.log('/clear - Clear current conversation');
          console.log('/compact - Force compact current conversation context');
          console.log('/skills [list|<name|index> <message>] - Run one message with a selected skill');
          console.log('/acp [status|on|off|cd] - Manage ACP mode for this CLI');
          console.log('/wt use <work-name> - Create a worktree + branch via worktree skill');
          console.log('/status - Show current session status');
          console.log('/mode - Show current plan mode');
          console.log('/plan - Switch to planning mode');
          console.log('/execute - Switch to executing mode');
          console.log('/save - Save current session explicitly');
          console.log('/exit - Exit the application');
          console.log('Esc (while processing) - Stop current response and accept next input');
          console.log('Ctrl+C - Exit CLI immediately');
          break;

        case 'new':
          const newTitle = args.join(' ') || undefined;
          await this.sessionCommands.createSession(newTitle);
          this.context.messages = [];
          await this.syncSessionTaskListBinding();
          break;

        case 'resume':
          if (args.length === 0) {
            console.log('\n❌ Please provide a session ID');
            console.log('Usage: /resume <session-id>');
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
            console.log('\n❌ Please provide a search query');
            console.log('Usage: /search <query>');
            break;
          }
          const query = args.join(' ');
          await this.sessionCommands.searchSessions(query);
          break;

        case 'rename':
          if (args.length < 2) {
            console.log('\n❌ Please provide session ID and new title');
            console.log('Usage: /rename <session-id> <new-title>');
            break;
          }
          const renameId = args[0];
          const newName = args.slice(1).join(' ');
          await this.sessionCommands.renameSession(renameId, newName);
          break;

        case 'delete':
          if (args.length === 0) {
            console.log('\n❌ Please provide a session ID');
            console.log('Usage: /delete <session-id>');
            break;
          }
          const deleteId = args[0];
          await this.sessionCommands.deleteSession(deleteId);
          break;

        case 'clear':
          this.context.messages = [];
          console.log('\n🧹 Current conversation cleared!');
          break;

        case 'compact':
          if (this.context.messages.length === 0) {
            console.log('\nℹ️ Context is empty, nothing to compact.');
            break;
          }

          const beforeCount = this.context.messages.length;
          const beforeTokens = this.estimateTokens(this.context.messages);
          const keepLastTurns = this.getKeepLastTurns();
          const compactResult = await this.agent.compactContext(this.context, { force: true });

          if (!compactResult.didCompact || !compactResult.newMessages) {
            console.log('\nℹ️ No compaction was applied.');
            console.log(`Messages: ${beforeCount}, estimated tokens: ~${beforeTokens}, KEEP_LAST_TURNS=${keepLastTurns}`);
            break;
          }

          this.context.messages = compactResult.newMessages;
          await this.sessionCommands.saveContext(this.context);

          const afterCount = this.context.messages.length;
          const afterTokens = this.estimateTokens(this.context.messages);
          const tokenDelta = beforeTokens - afterTokens;
          const tokenDeltaText = tokenDelta >= 0 ? `-${tokenDelta}` : `+${Math.abs(tokenDelta)}`;
          const reasonSuffix = compactResult.reason ? ` (${compactResult.reason})` : '';

          console.log(`\n🧩 Context compacted${reasonSuffix}`);
          console.log(`Messages: ${beforeCount} -> ${afterCount}`);
          console.log(`Estimated tokens: ~${beforeTokens} -> ~${afterTokens} (${tokenDeltaText})`);
          console.log(`KEEP_LAST_TURNS=${keepLastTurns}`);
          break;

        case 'skills':
          console.log('\nℹ️ Use /skills <name|index> <message> directly in input for one-shot skill execution.');
          break;

        case 'acp': {
          const message = await handleAcpCommand(this.acpPlatformKey, args);
          console.log(`\n${message}`);
          break;
        }

        case 'status':
          const currentId = this.sessionCommands.getCurrentSessionId();
          const currentTaskListId = this.sessionCommands.getCurrentTaskListId();
          console.log(`\n📊 Session Status:`);
          console.log(`Current Session: ${currentId || 'None (new session)'}`);
          console.log(`Task List: ${currentTaskListId || 'None'}`);
          console.log(`Messages: ${this.context.messages.length}`);
          if (currentId) {
            console.log(`To save this session, use: /save`);
          }
          break;

        case 'mode':
          const currentMode = this.agent.getMode();
          if (!currentMode) {
            console.log('\n⚠️ plan mode plugin unavailable');
            break;
          }

          console.log(`\n🧭 Current mode: ${currentMode}`);
          break;

        case 'plan':
          if (this.agent.setMode('planning', 'cli:/plan')) {
            console.log('\n✅ Switched to planning mode');
          } else {
            console.log('\n❌ Failed to switch mode: plan mode plugin unavailable');
          }
          break;

        case 'execute':
          if (this.agent.setMode('executing', 'cli:/execute')) {
            console.log('\n✅ Switched to executing mode');
          } else {
            console.log('\n❌ Failed to switch mode: plan mode plugin unavailable');
          }
          break;

        case 'save':
          if (this.sessionCommands.getCurrentSessionId()) {
            await this.sessionCommands.saveContext(this.context);
            console.log('\n💾 Current session saved!');
          } else {
            console.log('\n❌ No active session. Create one with /new');
          }
          break;

        case 'exit':
          console.log('💾 Saving current session...');
          await this.sessionCommands.saveContext(this.context);
          console.log('Goodbye!');
          process.exit(0);
          break;

        default:
          console.log(`\n⚠️ Unknown command: ${command}`);
          console.log('Type /help to see available commands');
      }
    } catch (error) {
      console.error('\n❌ Error executing command:', error);
    }
  }

  async start() {
    console.log('🚀 Pulse Coder CLI is running...');
    console.log('Type your messages and press Enter. Type "exit" to quit.');
    console.log('Press Esc to stop current response and continue with new input.');
    console.log('Press Ctrl+C to exit CLI.');
    console.log('Commands starting with "/" will trigger command mode.\n');

    await this.sessionCommands.initialize();
    await memoryIntegration.initialize();
    await this.agent.initialize();

    // 显示插件状态
    const pluginStatus = this.agent.getPluginStatus();
    console.log(`✅ Built-in plugins loaded: ${pluginStatus.enginePlugins.length} plugins`);

    // Auto-create a new session
    await this.sessionCommands.createSession();
    await this.syncSessionTaskListBinding();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> '
    });

    let currentAbortController: AbortController | null = null;
    let isProcessing = false;
    const queuedInputs: string[] = [];

    readline.emitKeypressEvents(process.stdin);

    const requestStopCurrentRun = (): boolean => {
      if (isProcessing) {
        if (currentAbortController && !currentAbortController.signal.aborted) {
          currentAbortController.abort();
          console.log('\n[Abort] Request cancelled by Esc. You can type the next message now.');
        } else {
          console.log('\n[Abort] Cancellation already requested. Waiting for current step to finish...');
        }
        rl.prompt();
        return true;
      }

      if (this.inputManager.hasPendingRequest()) {
        this.inputManager.cancel('User interrupted with Esc');
        console.log('\n[Abort] Clarification cancelled.');
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

      console.log('\n💾 Saving current session...');
      this.sessionCommands.saveContext(this.context).finally(() => {
        console.log('👋 Goodbye!');
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
          console.log('\n📝 Input queued. It will run right after the current step finishes.');
          rl.prompt();
          return;
        }

        console.log('\n⏳ Still processing. Press Esc to stop current request first.');
        rl.prompt();
        return;
      }

      if (trimmedInput.toLowerCase() === 'exit') {
        console.log('💾 Saving current session...');
        await this.sessionCommands.saveContext(this.context);
        console.log('👋 Goodbye!');
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
          console.log('\n⚠️ ACP 未启用，请先使用 /acp on <claude|codex>。');
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
          console.log('\n⚠️ Please provide a command after "/"');
          rl.prompt();
          return;
        }

        const command = parts[0];
        const args = parts.slice(1);
        const normalizedCommand = command.toLowerCase();

        if (!LOCAL_COMMANDS.has(normalizedCommand)) {
          const acpState = await getAcpState(this.acpPlatformKey);
          if (acpState) {
            forceAcp = true;
          } else {
            console.log(`\n⚠️ Unknown command: /${command}`);
            console.log('Type /help to see available commands');
            rl.prompt();
            return;
          }
        }

        if (!forceAcp) {
          if (normalizedCommand === 'skills') {
            const transformedMessage = await this.skillCommands.transformSkillsCommandToMessage(args);
            if (!transformedMessage) {
              rl.prompt();
              return;
            }

            messageInput = transformedMessage;
          } else if (normalizedCommand === 'wt') {
            if (args.length < 2 || args[0].toLowerCase() !== 'use') {
              console.log('\n❌ Usage: /wt use <work-name>');
              rl.prompt();
              return;
            }

            const workName = args.slice(1).join(' ').trim();
            if (!workName) {
              console.log('\n❌ Worktree name cannot be empty.');
              console.log('Usage: /wt use <work-name>');
              rl.prompt();
              return;
            }

            messageInput = `[use skill](worktree) new ${workName}`;
            console.log('\n✅ Worktree request prepared via skill: worktree');
          } else if (normalizedCommand === 'acp') {
            await this.handleCommand(command, args);
            rl.prompt();
            return;
          } else {
            await this.handleCommand(command, args);
            rl.prompt();
            return;
          }
        }
      }

      // Regular message processing
      this.context.messages.push({
        role: 'user',
        content: messageInput,
      });


      console.log('\n🔄 Processing...\n');

      const ac = new AbortController();
      currentAbortController = ac;
      isProcessing = true;

      let sawText = false;

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
            process.stdout.write(delta);
          },
          onToolCall: (toolCall) => {
            const input = getToolInput(toolCall);
            const inputText = input === undefined ? '' : `(${JSON.stringify(input)})`;
            process.stdout.write(`\n🔧 ${resolveToolName(toolCall)}${inputText}\n`);
          },
          onToolResult: (toolResult) => {
            const toolName = resolveToolName(toolResult as Record<string, unknown>);
            process.stdout.write(`\n✅ ${toolName}\n`);
          },
          onStepFinish: (step) => {
            process.stdout.write(`\n📋 Step finished: ${step.finishReason}\n`);
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
                process.stdout.write(delta);
              },
              onToolCall: (toolCall) => {
                const input = getToolInput(toolCall);
                const inputText = input === undefined ? '' : `(${JSON.stringify(input)})`;
                process.stdout.write(`\n🔧 ${resolveToolName(toolCall)}${inputText}\n`);
              },
              onToolResult: (toolResult) => {
                const toolName = resolveToolName(toolResult as Record<string, unknown>);
                process.stdout.write(`\n✅ ${toolName}\n`);
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

        if (result) {
          if (!sawText) {
            console.log(result);
          } else {
            console.log();
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
          console.log('\n[Abort] Operation cancelled.');
        } else {
          console.error('\n❌ Error:', error.message);
        }
      } finally {
        isProcessing = false;
        currentAbortController = null;

        if (queuedInputs.length > 0) {
          const nextInput = queuedInputs.shift();
          if (nextInput) {
            console.log('\n▶️ Running queued input...');
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
      console.log('\n💾 Saving current session...');
      await this.sessionCommands.saveContext(this.context);
      console.log('👋 Goodbye!');
      process.exit(0);
    });
  }
}

// Always start the CLI when executed directly
const cli = new CoderCLI();
cli.start().catch(error => {
  console.error('Failed to start CLI:', error);
  process.exit(1);
});