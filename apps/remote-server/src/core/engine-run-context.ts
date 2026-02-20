import { AsyncLocalStorage } from 'async_hooks';

export interface EngineMemoryRunContext {
  platformKey: string;
  sessionId: string;
  userText: string;
}

const engineMemoryRunContextStore = new AsyncLocalStorage<EngineMemoryRunContext>();

export async function withEngineMemoryRunContext<T>(
  context: EngineMemoryRunContext,
  run: () => Promise<T>,
): Promise<T> {
  return engineMemoryRunContextStore.run(context, run);
}

export function getEngineMemoryRunContext(): EngineMemoryRunContext | undefined {
  return engineMemoryRunContextStore.getStore();
}
