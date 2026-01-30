import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from "ai";
import generateTextAI from "./ai";
import { MAX_TURNS } from "./config";

export interface LoopOptions {
  onResult?: (result: any) => void;
}

async function loop(prompt: string, options?: LoopOptions) {
  const userMessage: ModelMessage = {
    role: 'user',
    content: prompt,
  };

  const messages: ModelMessage[] = [userMessage];
  let count = 0;

  while (true) {
    const result = await generateTextAI(messages);

    options?.onResult?.(result);

    count++;

    if (result.text || count >= MAX_TURNS) {
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