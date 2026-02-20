import type { EnginePlugin, SystemPromptOption } from 'pulse-coder-engine';
import { getEngineMemoryRunContext } from './engine-run-context.js';
import { memoryService } from './memory-service.js';

function appendSystemPrompt(base: SystemPromptOption | undefined, append: string): SystemPromptOption {
  const normalizedAppend = append.trim();
  if (!normalizedAppend) {
    return base ?? { append: '' };
  }

  if (!base) {
    return { append: normalizedAppend };
  }

  if (typeof base === 'string') {
    return `${base}\n\n${normalizedAppend}`;
  }

  if (typeof base === 'function') {
    return () => `${base()}\n\n${normalizedAppend}`;
  }

  const currentAppend = base.append.trim();
  return {
    append: currentAppend ? `${currentAppend}\n\n${normalizedAppend}` : normalizedAppend,
  };
}

export const memoryEnginePlugin: EnginePlugin = {
  name: 'remote-memory',
  version: '0.0.1',

  async initialize(context) {
    context.registerService('memoryService', memoryService);

    context.registerHook('beforeRun', async ({ systemPrompt }) => {
      const runContext = getEngineMemoryRunContext();
      if (!runContext) {
        return;
      }

      try {
        const recall = await memoryService.recall({
          platformKey: runContext.platformKey,
          sessionId: runContext.sessionId,
          query: runContext.userText,
        });

        if (!recall.promptAppend) {
          return;
        }

        return {
          systemPrompt: appendSystemPrompt(systemPrompt, recall.promptAppend),
        };
      } catch (error) {
        context.logger.warn('[memory-engine-plugin] recall failed', {
          platformKey: runContext.platformKey,
          sessionId: runContext.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });

    context.registerHook('afterRun', async ({ result }) => {
      const runContext = getEngineMemoryRunContext();
      if (!runContext) {
        return;
      }

      try {
        await memoryService.recordTurn({
          platformKey: runContext.platformKey,
          sessionId: runContext.sessionId,
          userText: runContext.userText,
          assistantText: result,
        });
      } catch (error) {
        context.logger.warn('[memory-engine-plugin] record turn failed', {
          platformKey: runContext.platformKey,
          sessionId: runContext.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  },
};
