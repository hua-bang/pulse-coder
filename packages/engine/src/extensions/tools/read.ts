import z from "zod";
import { readFileSync } from "fs";
import type { Tool } from "../../shared/types";
import { truncateOutput } from "./utils.js";

const ReadTool: Tool<
  { filePath: string },
  { content: string }
> = {
  name: 'read',
  description: 'Read the contents of a file',
  inputSchema: z.object({
    filePath: z.string().describe('The path to the file to read'),
  }),
  execute: async ({ filePath }) => {
    const content = readFileSync(filePath, 'utf-8');
    return { content: truncateOutput(content) };
  },
};

export default ReadTool;
