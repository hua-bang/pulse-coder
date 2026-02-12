import z from "zod";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { dirname } from "path";
import type { Tool } from "../shared/types";

export const WriteTool: Tool<
  { filePath: string; content: string },
  { success: boolean; created: boolean; bytes: number }
> = {
  name: 'write',
  description: 'Write contents to a file. Automatically creates parent directories if they do not exist. Will overwrite existing files.',
  inputSchema: z.object({
    filePath: z.string().describe('The absolute path to the file to write (must be absolute, not relative)'),
    content: z.string().describe('The content to write to the file'),
  }),
  execute: async ({ filePath, content }) => {
    // Check if file already exists
    const fileExists = existsSync(filePath);

    // Get the directory path
    const dir = dirname(filePath);

    // Create parent directories if they don't exist
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Write the file
    writeFileSync(filePath, content, 'utf-8');

    // Calculate bytes written
    const bytes = Buffer.byteLength(content, 'utf-8');

    return {
      success: true,
      created: !fileExists,
      bytes,
    };
  },
};

export default WriteTool;
