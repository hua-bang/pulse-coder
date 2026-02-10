import { Engine } from '@coder/engine';
import { skillRegistryPlugin } from '@coder/skills';
import { mcpPlugin } from '@coder/mcp-plugin';
import * as readline from 'readline';
import type { Context } from '@coder/engine';
import { SessionCommands } from './session-commands.js';

class CoderCLI {
  private engine: Engine;
  private context: Context;
  private sessionCommands: SessionCommands;

  constructor() {
    this.engine = new Engine({
      enginePlugins: {
        plugins: [skillRegistryPlugin, mcpPlugin],
        dirs: ['.coder/engine-plugins', '~/.coder/engine-plugins'],
        scan: true
      },
      userConfigPlugins: {
        dirs: ['.coder/config', '~/.coder/config'],
        scan: true
      }
    });
    this.context = { messages: [] };
    this.sessionCommands = new SessionCommands();
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
          console.log('/status - Show current session status');
          console.log('/save - Save current session explicitly');
          console.log('/exit - Exit the application');
          break;

        case 'new':
          const newTitle = args.join(' ') || undefined;
          await this.sessionCommands.createSession(newTitle);
          this.context.messages = [];
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

        case 'status':
          const currentId = this.sessionCommands.getCurrentSessionId();
          console.log(`\n📊 Session Status:`);
          console.log(`Current Session: ${currentId || 'None (new session)'}`);
          console.log(`Messages: ${this.context.messages.length}`);
          if (currentId) {
            console.log(`To save this session, use: /save`);
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
    console.log('🚀 Coder CLI is running...');
    console.log('Type your messages and press Enter. Type "exit" to quit.');
    console.log('Commands starting with "/" will trigger command mode.\n');

    await this.sessionCommands.initialize();
    await this.engine.initialize();

    // Auto-create a new session
    await this.sessionCommands.createSession();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: '> '
    });

    let currentAbortController: AbortController | null = null;
    let isProcessing = false;

    process.on('SIGINT', () => {
      if (isProcessing && currentAbortController && !currentAbortController.signal.aborted) {
        currentAbortController.abort();
        process.stdout.write('\n[Abort] Request cancelled.\n');
        return;
      }
      rl.close();
    });

    const processInput = async (input: string) => {
      const trimmedInput = input.trim();

      if (trimmedInput.toLowerCase() === 'exit') {
        console.log('💾 Saving current session...');
        await this.sessionCommands.saveContext(this.context);
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (!trimmedInput) {
        rl.prompt();
        return;
      }

      if (trimmedInput.startsWith('/')) {
        const commandLine = trimmedInput.substring(1);
        const parts = commandLine.split(/\s+/).filter(part => part.length > 0);

        if (parts.length === 0) {
          console.log('\n⚠️ Please provide a command after "/"');
          rl.prompt();
          return;
        }

        const command = parts[0];
        const args = parts.slice(1);

        await this.handleCommand(command, args);
        rl.prompt();
        return;
      }

      // Regular message processing
      this.context.messages.push({
        role: 'user',
        content: trimmedInput,
      });

      console.log('\n🔄 Processing...\n');

      const ac = new AbortController();
      currentAbortController = ac;
      isProcessing = true;

      let sawText = false;

      try {
        const result = await this.engine.run(this.context, {
          abortSignal: ac.signal,
          onText: (delta) => {
            sawText = true;
            process.stdout.write(delta);
          },
          onToolCall: (toolCall) => {
            const input = 'input' in toolCall ? toolCall.input : undefined;
            const inputText = input === undefined ? '' : `(${JSON.stringify(input)})`;
            process.stdout.write(`\n🔧 ${toolCall.toolName}${inputText}\n`);
          },
          onToolResult: (toolResult) => {
            process.stdout.write(`\n✅ ${toolResult.toolName}\n`);
          },
          onStepFinish: (step) => {
            process.stdout.write(`\n📋 Step finished: ${step.finishReason}\n`);
          },
        });

        if (!sawText && result) {
          console.log(result);
        } else {
          process.stdout.write('\n');
        }

        // Save session after each message
        if (result) {
          this.context.messages.push({
            role: 'assistant',
            content: result,
          });
          await this.sessionCommands.saveContext(this.context);
        }
      } finally {
        isProcessing = false;
        currentAbortController = null;
        rl.prompt();
      }
    };

    rl.prompt();
    rl.on('line', processInput);
    rl.on('close', async () => {
      console.log('\n💾 Saving current session...');
      await this.sessionCommands.saveContext(this.context);
      console.log('👋 Goodbye!');
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = new CoderCLI();
  cli.start();
}