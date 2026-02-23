import type { EmbeddingProvider } from '../types.js';
import { normalizeWhitespace, tokenize, uniqueWords } from '../utils/text.js';

export const MIN_EMBEDDING_DIMENSIONS = 64;
export const MAX_EMBEDDING_DIMENSIONS = 4096;

const SEMANTIC_SYNONYMS: Record<string, string[]> = {
  bug: ['issue', 'error', 'defect', 'problem'],
  fix: ['resolve', 'repair', 'patch', 'correct'],
  refactor: ['cleanup', 'restructure', 'rewrite'],
  optimize: ['improve', 'speed', 'performance', 'tune'],
  memory: ['remember', 'recall', 'context'],
  preference: ['prefer', 'default', 'habit'],
  rule: ['constraint', 'must', 'policy', 'guideline'],
};

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = clampEmbeddingDimensions(dimensions);
  }

  async embed(text: string): Promise<number[]> {
    const normalized = normalizeWhitespace(text).toLowerCase();
    if (!normalized) {
      return new Array(this.dimensions).fill(0);
    }

    const vector = new Array(this.dimensions).fill(0);
    const tokens = expandSemanticTokens(tokenize(normalized));
    const charNgrams = buildCharacterNgrams(normalized, 3, 120);

    for (const token of tokens) {
      addHashedWeight(vector, `tok:${token}`, 1.4);
    }

    for (const ngram of charNgrams) {
      addHashedWeight(vector, `chr:${ngram}`, 0.6);
    }

    return normalizeEmbeddingVector(vector, this.dimensions);
  }
}

function expandSemanticTokens(tokens: string[]): string[] {
  const expanded: string[] = [];
  for (const token of tokens) {
    expanded.push(token);
    const synonyms = SEMANTIC_SYNONYMS[token];
    if (synonyms) {
      expanded.push(...synonyms);
    }
  }
  return uniqueWords(expanded);
}

function buildCharacterNgrams(text: string, n: number, maxCount: number): string[] {
  const compact = text.replace(/\s+/g, '');
  if (compact.length < n) {
    return compact ? [compact] : [];
  }

  const grams: string[] = [];
  for (let i = 0; i <= compact.length - n && grams.length < maxCount; i += 1) {
    grams.push(compact.slice(i, i + n));
  }
  return grams;
}

function addHashedWeight(vector: number[], token: string, weight: number): void {
  const hash = hashString(token);
  const index = hash % vector.length;
  const sign = (hash & 1) === 0 ? 1 : -1;
  vector[index] += sign * weight;
}

function hashString(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function normalizeEmbeddingVector(vector: number[], dimensions: number): number[] {
  const trimmed = vector.slice(0, dimensions);
  while (trimmed.length < dimensions) {
    trimmed.push(0);
  }

  let norm = 0;
  for (const value of trimmed) {
    norm += value * value;
  }

  if (norm === 0) {
    return trimmed;
  }

  const scale = 1 / Math.sqrt(norm);
  return trimmed.map((value) => value * scale);
}

export function parseEmbedding(raw: string, dimensions: number): number[] | undefined {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return undefined;
    }

    const vector = parsed
      .slice(0, dimensions)
      .map((value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0));

    return normalizeEmbeddingVector(vector, dimensions);
  } catch {
    return undefined;
  }
}

export function cosineSimilarity(left: number[], right: number[]): number {
  const dimensions = Math.min(left.length, right.length);
  if (dimensions === 0) {
    return 0;
  }

  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;

  for (let i = 0; i < dimensions; i += 1) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    dot += l * r;
    leftNorm += l * l;
    rightNorm += r * r;
  }

  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }

  const cosine = dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
  return Math.min(1, Math.max(0, cosine));
}

function clampEmbeddingDimensions(value: number): number {
  return Math.min(MAX_EMBEDDING_DIMENSIONS, Math.max(MIN_EMBEDDING_DIMENSIONS, value));
}
