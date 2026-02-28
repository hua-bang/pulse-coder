import { loop } from '../../core/loop.js';
import type { Context } from '../../shared/types.js';

import type { AgentTeamNodeResult, AgentTeamSpec } from './types.js';
import { renderTemplate, safeToString } from './template.js';

export async function aggregateFinalText(
  spec: AgentTeamSpec,
  goal: string,
  runInput: Record<string, unknown>,
  trace: AgentTeamNodeResult[]
): Promise<string> {
  const nodeMap = Object.fromEntries(
    trace.map((item) => [item.id, {
      status: item.status,
      output: item.output,
      error: item.error,
      attempts: item.attempts
    }])
  );

  if (spec.finalAggregator.mode === 'llm') {
    const systemPrompt = spec.finalAggregator.systemPrompt
      ?? 'You aggregate multi-agent execution traces. Return a concise, clear final answer.';

    const context: Context = {
      messages: [
        {
          role: 'user',
          content: [
            `Goal: ${goal}`,
            `Input: ${safeToString(runInput)}`,
            `Trace: ${safeToString(nodeMap)}`,
            'Produce the final response in plain text and include key findings first.'
          ].join('\n\n')
        }
      ]
    };

    try {
      return await loop(context, { tools: {}, systemPrompt });
    } catch {
      // Fall through to deterministic summary.
    }
  }

  if (spec.finalAggregator.template) {
    return renderTemplate(spec.finalAggregator.template, {
      goal,
      input: runInput,
      nodes: nodeMap
    });
  }

  const lines = [`Team ${spec.teamId} finished goal: ${goal}`];
  for (const item of trace) {
    lines.push(`- [${item.status}] ${item.id} via ${item.agent}`);
    if (item.output !== undefined) {
      lines.push(`  output: ${safeToString(item.output)}`);
    }
    if (item.error) {
      lines.push(`  error: ${item.error}`);
    }
  }

  return lines.join('\n');
}
