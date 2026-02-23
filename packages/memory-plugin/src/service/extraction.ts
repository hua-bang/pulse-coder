import type { ExtractedMemory } from './models.js';
import type { MemorySourceType, MemoryType } from '../types.js';
import { normalizeContent, normalizeWhitespace, summarize, tokenize } from '../utils/text.js';

interface BuildChunksInput {
  userText: string;
  assistantText: string;
  sourceType: MemorySourceType;
  platformKey: string;
  sessionId: string;
  now: number;
}

interface SourceChunk {
  chunkId: string;
  sourceText: string;
  line: number;
  offset: number;
}

const MAX_CONTENT_LENGTH = 180;

export function extractMemoryCandidates(
  userText: string,
  assistantText: string,
  options?: Omit<BuildChunksInput, 'userText' | 'assistantText'>,
): ExtractedMemory[] {
  const results: ExtractedMemory[] = [];

  const userChunks = buildChunks({
    userText,
    assistantText,
    sourceType: options?.sourceType ?? 'explicit',
    platformKey: options?.platformKey ?? 'default',
    sessionId: options?.sessionId ?? 'default',
    now: options?.now ?? Date.now(),
  }, 'user');

  for (const chunk of userChunks) {
    const profilePattern = /(^profile:|my name is|call me|i go by|\u6211\u53eb|\u6211\u7684\u540d\u5b57\u662f|\u540d\u5b57\u662f|\u79f0\u547c\u6211)/i;
    const preferencePattern = /(prefer|always|never|please use|remember|default to|\u8bf7\u7528|\u4ee5\u540e|\u8bb0\u4f4f|\u9ed8\u8ba4|\u4e0d\u8981|\u5fc5\u987b)/i;
    const rulePattern = /(rule|constraint|must|should|require|\u89c4\u8303|\u7ea6\u675f|\u5fc5\u987b|\u7981\u6b62)/i;

    if (profilePattern.test(chunk.sourceText)) {
      results.push({
        scope: 'user',
        type: 'fact',
        content: chunk.sourceText,
        summary: summarize(chunk.sourceText, 120),
        keywords: tokenize(chunk.sourceText),
        confidence: 0.78,
        importance: 0.78,
        chunkId: chunk.chunkId,
        sourceRef: {
          path: buildSourcePath(options?.platformKey ?? 'default', options?.sessionId ?? 'default', options?.sourceType ?? 'explicit', options?.now ?? Date.now()),
          offset: chunk.offset,
          line: chunk.line,
        },
      });
      continue;
    }

    if (preferencePattern.test(chunk.sourceText) || rulePattern.test(chunk.sourceText)) {
      const type: MemoryType = rulePattern.test(chunk.sourceText) ? 'rule' : 'preference';
      const scope = type === 'rule' ? 'user' : 'session';

      results.push({
        scope,
        type,
        content: chunk.sourceText,
        summary: summarize(chunk.sourceText, 120),
        keywords: tokenize(chunk.sourceText),
        confidence: 0.72,
        importance: type === 'rule' ? 0.8 : 0.65,
        chunkId: chunk.chunkId,
        sourceRef: {
          path: buildSourcePath(options?.platformKey ?? 'default', options?.sessionId ?? 'default', options?.sourceType ?? 'explicit', options?.now ?? Date.now()),
          offset: chunk.offset,
          line: chunk.line,
        },
      });
    }
  }

  const assistantChunks = buildChunks({
    userText,
    assistantText,
    sourceType: options?.sourceType ?? 'explicit',
    platformKey: options?.platformKey ?? 'default',
    sessionId: options?.sessionId ?? 'default',
    now: options?.now ?? Date.now(),
  }, 'assistant');

  for (const chunk of assistantChunks) {
    const fixPattern = /(fixed|resolved|workaround|root cause|\u5df2\u4fee\u590d|\u95ee\u9898\u539f\u56e0|\u89e3\u51b3\u65b9\u6848)/i;
    if (fixPattern.test(chunk.sourceText)) {
      results.push({
        scope: 'session',
        type: 'fix',
        content: summarize(chunk.sourceText, MAX_CONTENT_LENGTH),
        summary: summarize(chunk.sourceText, 100),
        keywords: tokenize(chunk.sourceText),
        confidence: 0.7,
        importance: 0.65,
        chunkId: chunk.chunkId,
        sourceRef: {
          path: buildSourcePath(options?.platformKey ?? 'default', options?.sessionId ?? 'default', options?.sourceType ?? 'explicit', options?.now ?? Date.now()),
          offset: chunk.offset,
          line: chunk.line,
        },
      });
    }

    const decisionPattern = /(decide|decision|choose|selected|we will|plan is|adopt|\u91c7\u7528|\u51b3\u5b9a|\u65b9\u6848\u662f)/i;
    if (decisionPattern.test(chunk.sourceText)) {
      results.push({
        scope: 'session',
        type: 'decision',
        content: summarize(chunk.sourceText, MAX_CONTENT_LENGTH),
        summary: summarize(chunk.sourceText, 100),
        keywords: tokenize(chunk.sourceText),
        confidence: 0.68,
        importance: 0.62,
        chunkId: chunk.chunkId,
        sourceRef: {
          path: buildSourcePath(options?.platformKey ?? 'default', options?.sessionId ?? 'default', options?.sourceType ?? 'explicit', options?.now ?? Date.now()),
          offset: chunk.offset,
          line: chunk.line,
        },
      });
    }
  }

  return dedupeExtracted(results);
}

function buildChunks(input: BuildChunksInput, role: 'user' | 'assistant'): SourceChunk[] {
  const source = role === 'user' ? input.userText : input.assistantText;
  const normalized = normalizeWhitespace(source);
  if (!normalized) {
    return [];
  }

  const lines = source.split(/\r?\n/);
  const chunks: SourceChunk[] = [];
  let offset = 0;
  let chunkIndex = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const rawLine = lines[i] ?? '';
    const compact = normalizeWhitespace(rawLine);
    const lineStartOffset = offset;

    if (compact.length >= 8) {
      const chunkId = buildChunkId({
        platformKey: input.platformKey,
        sessionId: input.sessionId,
        sourceType: input.sourceType,
        now: input.now,
        role,
        index: chunkIndex,
      });

      chunks.push({
        chunkId,
        sourceText: compact,
        line: i + 1,
        offset: lineStartOffset,
      });
      chunkIndex += 1;
    }

    offset += rawLine.length + 1;
  }

  if (chunks.length > 0) {
    return chunks;
  }

  return [{
    chunkId: buildChunkId({
      platformKey: input.platformKey,
      sessionId: input.sessionId,
      sourceType: input.sourceType,
      now: input.now,
      role,
      index: 0,
    }),
    sourceText: normalized,
    line: 1,
    offset: 0,
  }];
}

function buildChunkId(input: {
  platformKey: string;
  sessionId: string;
  sourceType: MemorySourceType;
  now: number;
  role: 'user' | 'assistant';
  index: number;
}): string {
  const timestamp = new Date(input.now).toISOString().replace(/[:.]/g, '-');
  return [
    input.sourceType,
    sanitizeKey(input.platformKey),
    sanitizeKey(input.sessionId),
    timestamp,
    input.role,
    `c${input.index + 1}`,
  ].join(':');
}

function buildSourcePath(platformKey: string, sessionId: string, sourceType: MemorySourceType, now: number): string {
  const dayKey = new Date(now).toISOString().slice(0, 10);
  return `${sourceType}/${sanitizeKey(platformKey)}/${sanitizeKey(sessionId)}/${dayKey}.log`;
}

function sanitizeKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'default';
}

function dedupeExtracted(items: ExtractedMemory[]): ExtractedMemory[] {
  const seen = new Set<string>();
  const deduped: ExtractedMemory[] = [];
  for (const item of items) {
    const key = normalizeContent(item.content);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(item);
  }
  return deduped;
}
