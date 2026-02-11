import z from 'zod';
import type { Tool, ToolExecutionContext, Context } from '../../shared/types.js';
import { loop, type LoopOptions } from '../../core/loop.js';
import { truncateOutput } from '../../tools/utils.js';

export interface TaskToolOptions {
  /** All available tools (task tool will be excluded to prevent recursion) */
  getTools: () => Record<string, Tool>;
  /** Max steps for a sub-task (defaults to 30) */
  maxSubTaskSteps?: number;
}

/**
 * Create a Task tool that spawns a sub-agent to handle complex subtasks autonomously.
 *
 * The sub-agent gets its own context and runs through the same agent loop,
 * but without access to the `task` tool itself (preventing infinite recursion).
 */
export function createTaskTool(options: TaskToolOptions): Tool<
  { description: string; prompt: string },
  { result: string }
> {
  const TaskTool: Tool<
    { description: string; prompt: string },
    { result: string }
  > = {
    name: 'task',
    description: [
      'Launch a sub-agent to handle a complex subtask autonomously.',
      'The sub-agent has access to the same tools (read, write, bash, ls, etc.) and works independently.',
      'Use this when a task can be broken into independent sub-problems that benefit from focused execution.',
      'The sub-agent will return its result when finished.',
      '',
      'When to use:',
      '- Exploratory tasks: searching codebases, gathering context',
      '- Independent sub-problems: implementing a helper, writing tests, fixing a specific bug',
      '- Research: reading multiple files to answer a question',
      '',
      'When NOT to use:',
      '- Simple operations that take 1-2 tool calls',
      '- Tasks that require conversation with the user (use clarify instead)',
    ].join('\n'),
    inputSchema: z.object({
      description: z.string().describe('A short (3-5 word) description of the subtask'),
      prompt: z.string().describe('Detailed instructions for the sub-agent to execute'),
    }),
    execute: async ({ description, prompt }, executionContext?: ToolExecutionContext) => {
      const allTools = options.getTools();

      // Exclude the task tool itself to prevent infinite recursion
      const subTools: Record<string, Tool> = {};
      for (const [name, tool] of Object.entries(allTools)) {
        if (name !== 'task') {
          subTools[name] = tool;
        }
      }

      // Create a fresh context for the sub-agent
      const subContext: Context = {
        messages: [
          {
            role: 'user',
            content: [
              `You are a sub-agent working on a specific subtask. Complete the following task and report your findings/results clearly.`,
              '',
              `## Task: ${description}`,
              '',
              prompt,
            ].join('\n'),
          },
        ],
      };

      const loopOptions: LoopOptions = {
        tools: subTools,
        abortSignal: executionContext?.abortSignal,
        onClarificationRequest: executionContext?.onClarificationRequest,
      };

      const result = await loop(subContext, loopOptions);

      return { result: truncateOutput(result) };
    },
  };

  return TaskTool;
}
