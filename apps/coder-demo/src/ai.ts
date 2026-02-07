import { generateText, tool, type ModelMessage, type Tool } from 'ai';
import { CoderAI, DEFAULT_MODEL } from './config';
import { generateSystemPrompt } from './prompt';
import type { Tool as CoderTool } from './typings';

let cachedToolsMap: Record<string, Tool> | null = null;

/**
 * Initialize the tools map. Must be called once after skillRegistry.initialize().
 */
export function initializeAI(tools: CoderTool[]): void {
  cachedToolsMap = tools.reduce((acc, t) => {
    acc[t.name] = tool(t as Tool);
    return acc;
  }, {} as Record<string, Tool>);
}

export const generateTextAI = (messages: ModelMessage[]): ReturnType<typeof generateText> => {
  if (!cachedToolsMap) {
    throw new Error('AI not initialized. Call initializeAI() first.');
  }

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
    tools: cachedToolsMap,
  }) as unknown as ReturnType<typeof generateText>;
}

export default generateTextAI;
