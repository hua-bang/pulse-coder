import * as readline from 'readline';
import loop from "./loop";
import type { Context, LoopResult } from "./typings";
import { skillRegistry } from "./skill";
import { buildTools } from "./tools";
import { initializeAI } from "./ai";

/**
 * Check if input is a slash command targeting a skill (e.g. "/deep-research query").
 * Returns { skillName, rest } if matched, null otherwise.
 */
function parseSlashCommand(input: string): { skillName: string; rest: string } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;

  const spaceIdx = trimmed.indexOf(' ');
  const command = spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx);
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

  if (!command) return null;

  // Check if this command matches a registered skill
  if (skillRegistry.has(command)) {
    return { skillName: command, rest };
  }

  // Try fuzzy search
  const matches = skillRegistry.search(command);
  if (matches.length === 1 && matches[0]) {
    return { skillName: matches[0].name, rest };
  }

  return null;
}

function formatResult(result: LoopResult): string {
  const lines: string[] = [];
  lines.push(result.text);
  lines.push('');

  const turnCount = result.turns.length;
  const toolCount = result.turns.reduce((sum, t) => sum + t.toolCalls.length, 0);
  const durationSec = (result.totalDurationMs / 1000).toFixed(1);

  lines.push(`[${turnCount} turn(s), ${toolCount} tool call(s), ${durationSec}s, ${result.finishReason}]`);

  return lines.join('\n');
}

export const run = async () => {
  console.log('Coder Demo Core is running...');

  // 1. Initialize skill registry first
  await skillRegistry.initialize(process.cwd());

  // 2. Build tools (skill tool reads from registry)
  const tools = buildTools();

  // 3. Initialize AI layer with the built tools
  initializeAI(tools);

  console.log('Type your messages and press Enter. Type "exit" to quit.');
  console.log('Use /skill-name to invoke a skill directly.\n');

  const abortController = new AbortController();

  const context: Context = {
    messages: [],
    abortSignal: abortController.signal,
  };

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> '
  });

  const processInput = async (input: string) => {
    const trimmed = input.trim();

    if (trimmed.toLowerCase() === 'exit') {
      console.log('Goodbye!');
      rl.close();
      process.exit(0);
    }

    if (!trimmed) {
      rl.prompt();
      return;
    }

    // Handle built-in commands
    if (trimmed === '/skills') {
      const skills = skillRegistry.getAll();
      if (skills.length === 0) {
        console.log('No skills loaded.\n');
      } else {
        console.log('Available skills:');
        for (const s of skills) {
          console.log(`  /${s.name} - ${s.description}`);
        }
        console.log('');
      }
      rl.prompt();
      return;
    }

    // Handle slash command → skill invocation
    const slashCmd = parseSlashCommand(trimmed);
    if (slashCmd) {
      const skill = skillRegistry.get(slashCmd.skillName)!;
      const userMessage = slashCmd.rest
        ? `[Using skill: ${skill.name}]\n\nSkill instructions:\n${skill.content}\n\nUser request: ${slashCmd.rest}`
        : `[Using skill: ${skill.name}]\n\nSkill instructions:\n${skill.content}\n\nPlease follow the skill instructions above.`;

      context.messages.push({ role: 'user', content: userMessage });
    } else {
      context.messages.push({ role: 'user', content: trimmed });
    }

    console.log('\nProcessing...\n');

    const result = await loop(context, {
      hooks: {
        onTurnStart: ({ index }) => {
          console.log(`--- Turn ${index} ---`);
        },
        onText: (text) => {
          console.log(`[text] ${text.slice(0, 200)}${text.length > 200 ? '...' : ''}`);
        },
        onToolCallEnd: (info) => {
          const status = info.error ? `error: ${info.error}` : 'ok';
          console.log(`  [tool] ${info.toolName} (${info.durationMs}ms) ${status}`);
        },
        onError: (err, { index }) => {
          console.error(`  [error @ turn ${index}] ${err.message}`);
        },
      },
    });

    console.log(`\n${formatResult(result)}\n`);
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
