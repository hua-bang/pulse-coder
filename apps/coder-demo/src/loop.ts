import { type AssistantModelMessage, type ModelMessage, type ToolModelMessage, type Tool, Output } from "ai";
import generateTextAI, { generateObject } from "./ai";
import { MAX_TURNS } from "./config";
import { z } from "zod";
import type { Context } from "./typings";

export interface LoopOptions {
  onResult?: (result: any) => void;
}

async function checkLoopFinish(result: { text?: string }, context: { messages: ModelMessage[] }): Promise<boolean> {
  if (!result.text) {
    return false;
  }

  const assistanceMessage: ModelMessage = {
    role: 'assistant',
    content: result.text,
  };

  const messages: ModelMessage[] = [
    ...context.messages,
    assistanceMessage,
    {
      role: 'user',
      content: `Based on the below response, should the loop finish now? Please respond with a JSON object containing a boolean field "finish"`
    },
  ];


  const res = await generateObject(messages, z.object({
    finish: z.boolean().describe('Indicates whether the loop should finish or continue'),
  }));

  return res.finish;
}

async function loop(context: Context, options?: LoopOptions) {

  const { messages } = context;
  let count = 0;

  while (true) {
    const result = await generateTextAI(messages);

    options?.onResult?.(result);

    count++;

    if ((!result.toolCalls?.length && result.text) || count >= MAX_TURNS) {
      if (!await checkLoopFinish(result, { messages })) {
        messages.push({
          role: 'assistant',
          content: result.text || '',
        });
        continue;
      }
      return result.text || 'Max turns reached';
    }

    if (result.toolCalls?.length) {
      const assistantToolCalls: AssistantModelMessage['content'] = result.toolCalls.map(({ toolCallId, toolName, input }) => ({
        toolCallId,
        type: 'tool-call',
        toolName: toolName,
        input,
      }));

      messages.push({
        role: 'assistant',
        content: assistantToolCalls,
      });
    }


    if (result?.toolResults?.length) {

      const toolContents: ToolModelMessage['content'] = result.toolResults.map(({ toolCallId, output, toolName }) => ({
        toolCallId,
        type: 'tool-result',
        toolName: toolName,
        output: {
          type: 'json',
          value: output,
        },
      }));

      messages.push({
        role: 'tool',
        content: toolContents,
      });
    }
  }
}

export default loop;