import type { MemoryItem } from '../types.js';
import type { RecallScoreInput } from './models.js';

export function combineRecallScore(input: RecallScoreInput): number {
  const {
    keywordScore,
    semanticScore,
    recencyScore,
    qualityScore,
    pinned,
    hasKeywords,
    hasSemantic,
  } = input;

  let score = 0;
  if (hasKeywords && hasSemantic) {
    score = keywordScore * 0.38 + semanticScore * 0.32 + recencyScore * 0.17 + qualityScore * 0.13;
  } else if (hasKeywords) {
    score = keywordScore * 0.55 + recencyScore * 0.25 + qualityScore * 0.2;
  } else if (hasSemantic) {
    score = semanticScore * 0.65 + recencyScore * 0.2 + qualityScore * 0.15;
  } else {
    score = recencyScore * 0.7 + qualityScore * 0.3;
  }

  if (pinned) {
    score += 0.2;
  }

  return score;
}

export function buildMemoryPrompt(items: MemoryItem[]): string | undefined {
  if (items.length === 0) {
    return undefined;
  }

  const lines = [
    'Memory context from previous conversations (use only when relevant):',
    ...items.map((item, index) => {
      const flags = [item.type, item.scope, item.pinned ? 'pinned' : null].filter(Boolean).join(', ');
      return `${index + 1}. [${item.id}] (${flags}) ${item.summary}`;
    }),
    'If memory conflicts with the latest user instruction, follow the latest user instruction.',
  ];

  return lines.join('\n');
}
