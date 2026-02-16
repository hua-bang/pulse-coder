import z from 'zod';

import type { RunJsToolInput, RunJsToolOptions, RunJsToolOutput } from './types.js';

const DEFAULT_TOOL_NAME = 'run_js';
const DEFAULT_TOOL_DESCRIPTION =
  'Execute JavaScript in an isolated sandbox process. Returns result, stdout, stderr, and execution metadata.';

export function createRunJsTool(options: RunJsToolOptions) {
  const name = options.name ?? DEFAULT_TOOL_NAME;
  const description = options.description ?? DEFAULT_TOOL_DESCRIPTION;

  return {
    name,
    description,
    inputSchema: z.object({
      code: z.string().describe('JavaScript source code to execute in sandbox.'),
      input: z.any().optional().describe('Optional input object exposed as global `input` in sandbox.'),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('Optional timeout in milliseconds. Defaults to executor timeout.')
    }),
    execute: async (input: RunJsToolInput): Promise<RunJsToolOutput> => {
      return options.executor.execute(input);
    }
  };
}
