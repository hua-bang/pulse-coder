import z from "zod";
import { readdirSync } from "fs";
import type { Tool } from "../typings";

const LsTool: Tool<
  { path?: string },
  { files: string[] }
> = {
  name: 'ls',
  description: 'List files and directories in a given path',
  inputSchema: z.object({
    path: z.string().optional().describe('The path to list files from (defaults to current directory)'),
  }),
  execute: async ({ path = '.' }) => {
    const files = readdirSync(path);
    return { files };
  },
};

export default LsTool;
