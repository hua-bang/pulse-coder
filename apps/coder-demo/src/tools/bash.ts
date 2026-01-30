import z from "zod";
import { execSync } from "child_process";
import type { Tool } from "../typings";

const BashTool: Tool<
  { command: string },
  { output: string; error?: string }
> = {
  name: 'bash',
  description: 'Execute a bash command and return the output',
  inputSchema: z.object({
    command: z.string().describe('The bash command to execute'),
  }),
  execute: async ({ command }) => {
    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 10, // 10MB
      });
      return { output };
    } catch (error: any) {
      return {
        output: error.stdout || '',
        error: error.stderr || error.message,
      };
    }
  },
};

export default BashTool;
