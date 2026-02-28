import type { Tool } from '../../shared/types.js';

export function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) {
    return [];
  }

  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

export function clampMaxParallel(value: number | undefined, fallback: number, maxLimit: number): number {
  const candidate = value ?? fallback;
  return Math.max(1, Math.min(maxLimit, candidate));
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

export function resolveAgentToolName(agent: string): string {
  const trimmed = agent.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed === 'team_run') {
    throw new Error('team_run cannot be used as a node agent');
  }
  if (trimmed.endsWith('_agent')) {
    return trimmed;
  }
  return `${trimmed}_agent`;
}

export function resolveAgentTool(tools: Record<string, Tool>, agent: string): Tool<{ task: string; context?: Record<string, unknown> }, unknown> {
  const toolName = resolveAgentToolName(agent);
  const tool = tools[toolName] as Tool<{ task: string; context?: Record<string, unknown> }, unknown> | undefined;
  if (!tool?.execute) {
    throw new Error(`Agent tool "${toolName}" is not available`);
  }
  return tool;
}
