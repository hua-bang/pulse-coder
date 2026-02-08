import * as readline from 'readline';
import loop from "./loop";
import type { Context } from "./typings";
import { skillRegistry } from "./skill";

export const run = async () => {
  console.log('Coder Demo Core is running...');

  // 初始化技能注册表
  await skillRegistry.initialize(process.cwd());

  console.log('Type your messages and press Enter. Type "exit" to quit.\n');

  const context: Context = {
    messages: [],
  };

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

    // Add user message to context
    context.messages.push({
      role: 'user',
      content: input.trim(),
    });

    console.log('\nProcessing...\n');

    const ac = new AbortController();
    currentAbortController = ac;
    isProcessing = true;

    let sawText = false;

    try {
      const result = await loop(context, {
        abortSignal: ac.signal,
        onText: (delta) => {
          sawText = true;
          process.stdout.write(delta);
        },
        onToolCall: (toolCall) => {
          const input = 'input' in toolCall ? toolCall.input : undefined;
          const inputText = input === undefined ? '' : `(${JSON.stringify(input)})`;
          process.stdout.write(`\n[Tool] ${toolCall.toolName}${inputText}\n`);
        },
        onToolResult: (toolResult) => {
          process.stdout.write(`\n[Tool Result] ${toolResult.toolName}\n`);
        },
        onStepFinish: (step) => {
          process.stdout.write(`\n[Step finished] reason: ${step.finishReason}\n`);
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

  rl.on('line', async (input: string) => {
    await processInput(input);
  });

  rl.on('close', () => {
    console.log('\nGoodbye!');
    process.exit(0);
  });
}

// 帮我在 /Users/colepol/project/Coder/apps 目录新建一个贪吃蛇游戏，用 HTML 实现即可
