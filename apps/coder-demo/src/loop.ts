import type { ModelMessage, ToolModelMessage } from "ai";
import generateTextAI from "./ai";
import { MAX_TURNS } from "./config";

async function loop(prompt: string) {
  const userMessage: ModelMessage = {
    role: 'user',
    content: prompt,
  };

  const messages: ModelMessage[] = [userMessage];
  let count = 0;

  while (true) {
    const result = await generateTextAI(messages);

    count++;

    if (result.text || count >= MAX_TURNS) {
      return result.text || 'Max turns reached';
    }

    if (result?.toolResults?.length) {
      const toolMessages: ToolModelMessage[] = result.toolResults.map(({ toolCallId, output, toolName }) => ({
        role: 'tool',
        content: [{
          toolCallId,
          type: 'tool-result',
          toolName: toolName,
          output: {
            type: 'json',
            value: output,
          },
        }],
      }));
      messages.push(...toolMessages);
    }
  }
}

export default loop;