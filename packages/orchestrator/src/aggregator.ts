import type { NodeResult, AggregateStrategy } from './types';

export function aggregateResults(
  results: Record<string, NodeResult>,
  strategy: AggregateStrategy = 'concat'
): string {
  const ordered = Object.values(results).sort((a, b) => a.startedAt - b.startedAt);

  if (strategy === 'last') {
    const last = ordered.filter(r => r.status === 'success').at(-1);
    return last?.output ?? '';
  }

  // concat
  return ordered
    .map(r => `[${r.role}] ${r.status.toUpperCase()}\n${r.output ?? r.error ?? r.skippedReason ?? ''}`.trim())
    .filter(Boolean)
    .join('\n\n');
}
