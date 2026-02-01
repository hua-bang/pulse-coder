import * as readline from 'readline';
import loop from "./loop";
import type { Context } from "./typings";

export const run = async () => {
  console.log('Coder Demo Core is running...');
  console.log('Type your messages and press Enter. Type "exit" to quit.\n');

  const context: Context = {
    messages: [],
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
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

    // Call loop with the updated context
    const result = await loop(context, {
      onResult: (result) => {
        console.log(`
Step:  \n
- Result Text: ${result.text || 'N/A'}\n
- Tool Calls: ${result.toolCalls ? JSON.stringify(result.toolCalls, null, 2) : 'N/A'}\n
- Tool Results: ${result.toolResults ? JSON.stringify(result.toolResults, null, 2) : 'N/A'}\n          
- result.reasoningText: ${result.reasoningText || 'N/A'}\n
      `);
      },
    });

    console.log(`\nResult: ${result}\n`);
    rl.prompt();
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