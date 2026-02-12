import z from "zod";
import { execSync } from "child_process";
import type { Tool } from "../shared/types";
import { truncateOutput } from "./utils";

export const BashTool: Tool<
  { command: string; timeout?: number; cwd?: string; description?: string },
  { output: string; error?: string; exitCode?: number }
> = {
  name: 'bash',
  description: 'Execute a bash command and return the output. Supports timeout and working directory configuration.',
  inputSchema: z.object({
    command: z.string().describe('The bash command to execute'),
    timeout: z.number().optional().describe('Optional timeout in milliseconds (max 600000ms / 10 minutes). Defaults to 120000ms (2 minutes).'),
    cwd: z.string().optional().describe('Optional working directory for command execution. Defaults to current directory.'),
    description: z.string().optional().describe('Optional description of what this command does (for logging/debugging)'),
  }),
  execute: async ({ command, timeout = 120000, cwd, description }) => {
    // Validate timeout
    if (timeout && (timeout < 0 || timeout > 600000)) {
      throw new Error('Timeout must be between 0 and 600000ms (10 minutes)');
    }

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 10, // 10MB
        timeout: timeout || 120000,
        cwd: cwd || process.cwd(),
        shell: '/bin/bash',
      });
      return {
        output: truncateOutput(output || '(command completed with no output)'),
        exitCode: 0,
      };
    } catch (error: any) {
      const exitCode = error.status || error.code || 1;
      const stdout = String(error.stdout || '');
      const stderr = String(error.stderr || error.message || '');

      // Check if it's a timeout error
      if (error.killed && error.signal === 'SIGTERM') {
        return {
          output: truncateOutput(stdout),
          error: truncateOutput(`Command timed out after ${timeout}ms\n${stderr}`),
          exitCode,
        };
      }

      return {
        output: truncateOutput(stdout),
        error: truncateOutput(stderr),
        exitCode,
      };
    }
  },
};

export default BashTool;
