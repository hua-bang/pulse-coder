import { tool, type AssistantModelMessage, type ModelMessage, type ToolModelMessage, type Tool, Output } from "ai";
import generateTextAI, { generateObject } from "./ai";
import { MAX_TURNS } from "./config";
import { BuiltinTools } from "./tools";
import { z } from "zod";

export interface LoopOptions {
  onResult?: (result: any) => void;
}

const BuiltinToolsMap = BuiltinTools.reduce((acc, toolInstance) => {
  acc[toolInstance.name] = tool(toolInstance as Tool);
  return acc;
}, {} as Record<string, Tool>);

async function checkLoopFinish(result: { text?: string }, context: { messages: ModelMessage[] }): Promise<boolean> {
  if (!result.text) {
    return false;
  }

  const assistanceMessage: ModelMessage = {
    role: 'assistant',
    content: result.text,
  };


  const prompt = `
    Based on the below response, should the loop finish now? Please respond with a JSON object containing a boolean field "finish".
    <MessageList>
      ${context.messages.map((message) => `<Message role="${message.role}">${message.content}</Message>`).join('\n')}
      <Message role="${assistanceMessage.role}">${assistanceMessage.content}</Message>
    </MessageList>
  `;


  const res = await generateObject(prompt, z.object({
    finish: z.boolean().describe('Indicates whether the loop should finish or continue'),
  }));

  return res.finish;
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