import z from "zod";
import { execSync } from "child_process";
import { existsSync } from "fs";
import type { Tool } from "../shared/types";
import { truncateOutput } from "./utils";

export const GrepTool: Tool<
  {
    pattern: string;
    path?: string;
    glob?: string;
    type?: string;
    outputMode?: 'content' | 'files_with_matches' | 'count';
    context?: number;
    caseInsensitive?: boolean;
    headLimit?: number;
    offset?: number;
    multiline?: boolean;
  },
  { output: string; matches?: number }
> = {
  name: 'grep',
  description: 'A powerful search tool built on ripgrep. Supports regex patterns, file filtering, and multiple output modes.',
  inputSchema: z.object({
    pattern: z.string().describe('The regular expression pattern to search for in file contents'),
    path: z.string().optional().describe('File or directory to search in. Defaults to current working directory.'),
    glob: z.string().optional().describe('Glob pattern to filter files (e.g. "*.js", "*.{ts,tsx}")'),
    type: z.string().optional().describe('File type to search (e.g., js, py, rust, go, java, ts, tsx, json, md)'),
    outputMode: z.enum(['content', 'files_with_matches', 'count']).optional().default('files_with_matches')
      .describe('Output mode: "content" shows matching lines, "files_with_matches" shows file paths, "count" shows match counts'),
    context: z.number().optional().describe('Number of lines to show before and after each match (only with output_mode: "content")'),
    caseInsensitive: z.boolean().optional().default(false).describe('Case insensitive search'),
    headLimit: z.number().optional().default(0).describe('Limit output to first N lines/entries. 0 means unlimited.'),
    offset: z.number().optional().default(0).describe('Skip first N lines/entries before applying head_limit'),
    multiline: z.boolean().optional().default(false).describe('Enable multiline mode where patterns can span lines'),
  }),
  execute: async ({
    pattern,
    path = '.',
    glob,
    type,
    outputMode = 'files_with_matches',
    context,
    caseInsensitive = false,
    headLimit = 0,
    offset = 0,
    multiline = false,
  }) => {
    // Build ripgrep command
    const args: string[] = ['rg'];

    // Pattern
    args.push(pattern);

    // Case sensitivity
    if (caseInsensitive) {
      args.push('-i');
    }

    // Output mode
    if (outputMode === 'files_with_matches') {
      args.push('-l'); // --files-with-matches
    } else if (outputMode === 'count') {
      args.push('-c'); // --count
    } else if (outputMode === 'content') {
      args.push('-n'); // Show line numbers
      if (context !== undefined) {
        args.push(`-C${context}`);
      }
    }

    // Multiline mode
    if (multiline) {
      args.push('-U'); // --multiline
      args.push('--multiline-dotall');
    }

    // File filtering
    if (glob) {
      args.push('--glob', glob);
    }
    if (type) {
      args.push('--type', type);
    }

    // Path
    if (path && path !== '.') {
      // Verify path exists
      if (!existsSync(path)) {
        throw new Error(`Path does not exist: ${path}`);
      }
      args.push(path);
    }

    // Build the command string
    let command = args.map(arg => {
      // Quote arguments that contain spaces or special characters
      if (arg.includes(' ') || arg.includes('$') || arg.includes('*')) {
        return `'${arg.replace(/'/g, "'\\''")}'`;
      }
      return arg;
    }).join(' ');

    // Add tail/head for offset/limit
    if (offset > 0) {
      command += ` | tail -n +${offset + 1}`;
    }
    if (headLimit > 0) {
      command += ` | head -n ${headLimit}`;
    }

    try {
      const output = execSync(command, {
        encoding: 'utf-8',
        maxBuffer: 1024 * 1024 * 10, // 10MB
        shell: '/bin/bash',
      });

      // Count matches for count mode
      let matches: number | undefined;
      if (outputMode === 'count') {
        matches = output.split('\n').filter(line => line.trim()).length;
      } else if (outputMode === 'files_with_matches') {
        matches = output.split('\n').filter(line => line.trim()).length;
      }

      return {
        output: truncateOutput(output || '(no matches found)'),
        matches,
      };
    } catch (error: any) {
      // Exit code 1 means no matches found (not an error)
      if (error.status === 1) {
        return {
          output: '(no matches found)',
          matches: 0,
        };
      }

      // Other errors
      throw new Error(
        `grep failed: ${error.stderr || error.message}\nCommand: ${command}`
      );
    }
  },
};

export default GrepTool;
