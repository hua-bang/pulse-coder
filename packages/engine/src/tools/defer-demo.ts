import type { Tool } from "../shared/types";
import z from 'zod';

const toolSchema = z.object({
  message: z.string().min(1).describe('Message to echo back.'),
});

type DeferDemoInput = z.infer<typeof toolSchema>;

type DeferDemoResult = {
  ok: true;
  echoed: string;
  receivedAt: string;
};

export const deferDemoTool: Tool<DeferDemoInput, DeferDemoResult> = {
  name: 'deferred_demo',
  description: 'Demo deferred tool that echoes a short message.',
  inputSchema: toolSchema,
  defer_loading: true,
  execute: async (input) => {
    return {
      ok: true,
      echoed: input.message,
      receivedAt: new Date().toISOString(),
    };
  },
};
