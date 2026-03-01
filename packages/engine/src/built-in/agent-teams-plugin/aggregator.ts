import type { NodeResult } from './types';

export interface AggregateOptions {
  results: Record<string, NodeResult>;
}

export function aggregateResults(options: AggregateOptions): string {
  const ordered = Object.values(options.results).sort((a, b) => a.startedAt - b.startedAt);
  const sections = ordered.map(result => {
    const header = `[${result.role}] ${result.status.toUpperCase()}`;
    const body = result.output ?? result.error ?? result.skippedReason ?? '';
    return `${header}\n${body}`.trim();
  });

  return sections.filter(Boolean).join('\n\n');
}
