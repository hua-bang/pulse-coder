import { generateText, tool, type ModelMessage, type Tool } from 'ai';
import { CoderAI, DEFAULT_MODEL } from './config';
import { BuiltinTools } from './tools';
import { generateSystemPrompt } from './prompt';

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
    tools: BuiltinToolsMap,
    toolChoice: 'required',
  }) as unknown as ReturnType<typeof generateText>;
}

export default generateTextAI;