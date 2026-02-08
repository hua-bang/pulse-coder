import z from "zod";
import { writeFileSync } from "fs";
import type { Tool } from "../../shared/types";

const WriteTool: Tool<
  { filePath: string; content: string },
  { success: boolean }
> = {
  name: 'write',
  description: 'Write contents to a file',
  inputSchema: z.object({
    filePath: z.string().describe('The path to the file to write'),
    content: z.string().describe('The content to write to the file'),
  }),
  execute: async ({ filePath, content }) => {
    writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  },
};

export default WriteTool;
