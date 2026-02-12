import z from "zod";
import { readFileSync, existsSync, statSync } from "fs";
import type { Tool } from "../shared/types";
import { truncateOutput } from "./utils";

export const ReadTool: Tool<
  { filePath: string; offset?: number; limit?: number },
  { content: string; totalLines?: number }
> = {
  name: 'read',
  description: 'Read the contents of a file. Supports reading specific line ranges with offset and limit.',
  inputSchema: z.object({
    filePath: z.string().describe('The absolute path to the file to read'),
    offset: z.number().optional().describe('The line number to start reading from (0-based). Only provide if the file is too large to read at once.'),
    limit: z.number().optional().describe('The number of lines to read. Only provide if the file is too large to read at once.'),
  }),
  execute: async ({ filePath, offset, limit }) => {
    // Check if file exists
    if (!existsSync(filePath)) {
      throw new Error(`File does not exist: ${filePath}`);
    }

    // Check if it's a directory
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      throw new Error(`Cannot read directory: ${filePath}. Use 'ls' tool to list directory contents.`);
    }

    // Read the entire file
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    // If no offset/limit specified, return the entire file
    if (offset === undefined && limit === undefined) {
      return {
        content: truncateOutput(content),
        totalLines,
      };
    }

    // Apply offset and limit
    const startLine = offset || 0;
    const endLine = limit ? startLine + limit : lines.length;

    // Validate range
    if (startLine < 0 || startLine >= totalLines) {
      throw new Error(`Invalid offset: ${startLine}. File has ${totalLines} lines.`);
    }

    // Extract the requested lines
    const selectedLines = lines.slice(startLine, endLine);

    // Format with line numbers (1-based for display)
    const numberedContent = selectedLines
      .map((line, idx) => {
        const lineNum = startLine + idx + 1;
        return `${String(lineNum).padStart(6, ' ')}→${line}`;
      })
      .join('\n');

    return {
      content: truncateOutput(numberedContent),
      totalLines,
    };
  },
};

export default ReadTool;
