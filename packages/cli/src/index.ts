import { Engine } from '@coder/engine';
import { skillPlugin } from '@coder/skills';
import * as readline from 'readline';
import type { Context } from '@coder/engine';

class CoderCLI {
  private engine: Engine;
  private context: Context;

  constructor() {
    this.engine = new Engine({ plugins: [skillPlugin] });
    this.context = { messages: [] };
  }

  async start() {
    console.log('🚀 Coder CLI is running...');
    console.log('Type your messages and press Enter. Type "exit" to quit.\n');

    await this.engine.loadPlugin(skillPlugin);

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
      if (input.trim().toLowerCase() === 'exit') {
        console.log('Goodbye!');
        rl.close();
        process.exit(0);
      }

      if (!input.trim()) {
        rl.prompt();
        return;
      }

      this.context.messages.push({
        role: 'user',
        content: input.trim(),
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
      } finally {
        isProcessing = false;
        currentAbortController = null;
        rl.prompt();
      }
    };

    rl.prompt();
    rl.on('line', processInput);
    rl.on('close', () => {
      console.log('\n👋 Goodbye!');
      process.exit(0);
    });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cli = new CoderCLI();
  cli.start().catch(console.error);
}
