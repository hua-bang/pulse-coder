import { generateText, Output, tool, type ModelMessage, type Tool } from 'ai';
import { CoderAI, DEFAULT_MODEL } from './config';
import { BuiltinTools } from './tools';
import { generateSystemPrompt } from './prompt';
import z from 'zod';

const BuiltinToolsMap = BuiltinTools.reduce((acc, toolInstance) => {
  acc[toolInstance.name] = tool(toolInstance as Tool);
  return acc;
}, {} as Record<string, Tool>);

export const generateTextAI = (messages: ModelMessage[]): ReturnType<typeof generateText> => {
  const finalMessages = [
    {
      role: 'system',
      content: generateSystemPrompt(),
    },
    ...messages,
  ] as ModelMessage[];

  return generateText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: finalMessages,
    tools: BuiltinToolsMap
  }) as unknown as ReturnType<typeof generateText>;
}

export const generateObject = async <T extends z.ZodSchema>(messages: ModelMessage[], schema: T, description: string) => {
  // 使用 tool calling 的方式来实现结构化输出
  const result = await generateText({
    model: CoderAI.chat(DEFAULT_MODEL),
    messages: messages,
    tools: {
      respond: tool({
        description,
        inputSchema: schema,
        execute: async (input: any) => input,
      })
    },
    toolChoice: {
      type: 'tool',
      toolName: 'respond',
    }
  });

  // 返回 tool call 的结果
  if (result.toolCalls && result.toolCalls.length > 0) {
    return result!.toolCalls[0]!.input as z.infer<T>;
  }

  console.log(result);

  throw new Error('No structured output generated');
}

export default generateTextAI;