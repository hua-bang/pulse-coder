import type { NodeResult, AggregateStrategy } from './types';

const SUMMARIZE_SYSTEM_PROMPT = `You are a report summarizer for a multi-agent system.
You will receive outputs from multiple agents that worked on the same task.
Synthesize their results into a single, coherent report.

Rules:
- Merge overlapping information, do not repeat.
- Preserve key details: file paths, line numbers, concrete findings.
- Use clear headings to organize the report.
- If agents disagreed, note the disagreement.
- Be concise but thorough.`;

export function aggregateResults(
  results: Record<string, NodeResult>,
  strategy: AggregateStrategy = 'concat',
  _llmCall?: (systemPrompt: string, userPrompt: string) => Promise<string>,
): string {
  // For 'llm' strategy, caller must use aggregateResultsAsync instead
  return concatResults(results);
}

export async function aggregateResultsAsync(
  results: Record<string, NodeResult>,
  strategy: AggregateStrategy = 'concat',
  llmCall?: (systemPrompt: string, userPrompt: string) => Promise<string>,
): Promise<string> {
  if (strategy === 'llm' && llmCall) {
    return llmSummarize(results, llmCall);
  }

  if (strategy === 'last') {
    const ordered = Object.values(results).sort((a, b) => a.startedAt - b.startedAt);
    const last = ordered.filter(r => r.status === 'success').at(-1);
    return last?.output ?? '';
  }

  return concatResults(results);
}

function concatResults(results: Record<string, NodeResult>): string {
  const ordered = Object.values(results).sort((a, b) => a.startedAt - b.startedAt);
  return ordered
    .map(r => `[${r.role}] ${r.status.toUpperCase()}\n${r.output ?? r.error ?? r.skippedReason ?? ''}`.trim())
    .filter(Boolean)
    .join('\n\n');
}

async function llmSummarize(
  results: Record<string, NodeResult>,
  llmCall: (systemPrompt: string, userPrompt: string) => Promise<string>,
): Promise<string> {
  const ordered = Object.values(results).sort((a, b) => a.startedAt - b.startedAt);

  const sections = ordered
    .filter(r => r.status === 'success' && r.output)
    .map(r => `## [${r.role}] ${r.nodeId}\n${r.output}`)
    .join('\n\n');

  if (!sections) {
    return concatResults(results);
  }

  const userPrompt = `Here are the outputs from each agent:\n\n${sections}\n\nPlease synthesize a unified report.`;
  return llmCall(SUMMARIZE_SYSTEM_PROMPT, userPrompt);
}
