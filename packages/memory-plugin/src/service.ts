import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  FileMemoryServiceOptions,
  ListInput,
  MemoryItem,
  MemoryScope,
  MemoryState,
  MemoryType,
  MutateResult,
  RecallInput,
  RecallResult,
  RecordTurnInput,
  ToggleResult,
} from './types.js';

interface ExtractedMemory {
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  summary: string;
  keywords: string[];
  confidence: number;
  importance: number;
}

export class FileMemoryPluginService {
  private readonly baseDir: string;
  private readonly statePath: string;
  private readonly maxItemsPerUser: number;
  private readonly defaultRecallLimit: number;

  private initialized = false;
  private state: MemoryState = { items: [], sessionEnabled: {} };

  constructor(options: FileMemoryServiceOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.pulse-coder', 'memory-plugin');
    this.statePath = join(this.baseDir, 'state.json');
    this.maxItemsPerUser = options.maxItemsPerUser ?? 500;
    this.defaultRecallLimit = options.defaultRecallLimit ?? 5;
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    await fs.mkdir(this.baseDir, { recursive: true });

    try {
      const raw = await fs.readFile(this.statePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<MemoryState>;
      this.state.items = Array.isArray(parsed.items) ? parsed.items : [];
      this.state.sessionEnabled = parsed.sessionEnabled && typeof parsed.sessionEnabled === 'object'
        ? parsed.sessionEnabled
        : {};
    } catch {
      this.state = { items: [], sessionEnabled: {} };
    }

    this.initialized = true;
  }

  isSessionEnabled(platformKey: string, sessionId: string): boolean {
    const key = this.sessionKey(platformKey, sessionId);
    return this.state.sessionEnabled[key] !== false;
  }

  async setSessionEnabled(platformKey: string, sessionId: string, enabled: boolean): Promise<ToggleResult> {
    const key = this.sessionKey(platformKey, sessionId);
    this.state.sessionEnabled[key] = enabled;
    await this.saveState();
    return { ok: true, enabled };
  }

  async recall(input: RecallInput): Promise<RecallResult> {
    const enabled = this.isSessionEnabled(input.platformKey, input.sessionId);
    if (!enabled) {
      return { enabled, items: [] };
    }

    const limit = clamp(input.limit ?? this.defaultRecallLimit, 1, 8);
    const queryTokens = tokenize(input.query);
    const now = Date.now();

    const ranked = this.state.items
      .filter((item) => this.isCandidateVisible(item, input.platformKey, input.sessionId))
      .map((item) => ({
        item,
        score: scoreItem(item, queryTokens, now),
      }))
      .filter((entry) => entry.score > 0.15)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((entry) => entry.item);

    const promptAppend = buildMemoryPrompt(ranked);
    return {
      enabled,
      items: ranked,
      promptAppend,
    };
  }

  async list(input: ListInput): Promise<MemoryItem[]> {
    const now = Date.now();
    return this.state.items
      .filter((item) => this.isCandidateVisible(item, input.platformKey, input.sessionId))
      .sort((a, b) => {
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        return b.updatedAt - a.updatedAt;
      })
      .slice(0, clamp(input.limit ?? 20, 1, 50))
      .map((item) => ({ ...item, lastAccessedAt: item.lastAccessedAt || now }));
  }

  async pin(platformKey: string, id: string): Promise<MutateResult> {
    const item = this.state.items.find((candidate) => candidate.id === id && candidate.platformKey === platformKey && !candidate.deleted);
    if (!item) {
      return { ok: false, reason: 'memory not found' };
    }

    item.pinned = true;
    item.updatedAt = Date.now();
    await this.saveState();
    return { ok: true, item };
  }

  async forget(platformKey: string, id: string): Promise<MutateResult> {
    const item = this.state.items.find((candidate) => candidate.id === id && candidate.platformKey === platformKey && !candidate.deleted);
    if (!item) {
      return { ok: false, reason: 'memory not found' };
    }

    item.deleted = true;
    item.updatedAt = Date.now();
    await this.saveState();
    return { ok: true, item };
  }

  async recordTurn(input: RecordTurnInput): Promise<void> {
    if (!this.isSessionEnabled(input.platformKey, input.sessionId)) {
      return;
    }

    const extracted = extractMemoryCandidates(input.userText, input.assistantText).slice(0, 3);
    if (extracted.length === 0) {
      return;
    }

    const now = Date.now();
    for (const candidate of extracted) {
      const duplicate = this.state.items.find((item) => {
        if (item.platformKey !== input.platformKey || item.deleted) {
          return false;
        }
        return normalizeContent(item.content) === normalizeContent(candidate.content);
      });

      if (duplicate) {
        duplicate.updatedAt = now;
        duplicate.lastAccessedAt = now;
        duplicate.confidence = Math.max(duplicate.confidence, candidate.confidence);
        duplicate.importance = Math.max(duplicate.importance, candidate.importance);
        duplicate.keywords = uniqueWords([...duplicate.keywords, ...candidate.keywords]);
        continue;
      }

      const nextItem: MemoryItem = {
        id: randomUUID().slice(0, 8),
        platformKey: input.platformKey,
        sessionId: candidate.scope === 'session' ? input.sessionId : undefined,
        scope: candidate.scope,
        type: candidate.type,
        content: candidate.content,
        summary: candidate.summary,
        keywords: candidate.keywords,
        confidence: candidate.confidence,
        importance: candidate.importance,
        pinned: false,
        deleted: false,
        createdAt: now,
        updatedAt: now,
        lastAccessedAt: now,
      };
      this.state.items.push(nextItem);
    }

    this.compact(input.platformKey);
    await this.saveState();
  }

  private async saveState(): Promise<void> {
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  private sessionKey(platformKey: string, sessionId: string): string {
    return `${platformKey}:${sessionId}`;
  }

  private compact(platformKey: string): void {
    const active = this.state.items
      .filter((item) => item.platformKey === platformKey && !item.deleted)
      .sort((a, b) => {
        if (a.pinned !== b.pinned) {
          return a.pinned ? -1 : 1;
        }
        const scoreA = a.importance * 0.6 + a.confidence * 0.4;
        const scoreB = b.importance * 0.6 + b.confidence * 0.4;
        if (scoreA !== scoreB) {
          return scoreB - scoreA;
        }
        return b.updatedAt - a.updatedAt;
      });

    if (active.length <= this.maxItemsPerUser) {
      return;
    }

    const toDrop = new Set(active.slice(this.maxItemsPerUser).map((item) => item.id));
    this.state.items = this.state.items.filter((item) => {
      if (item.platformKey !== platformKey) {
        return true;
      }
      return !toDrop.has(item.id);
    });
  }

  private isCandidateVisible(item: MemoryItem, platformKey: string, sessionId?: string): boolean {
    if (item.platformKey !== platformKey || item.deleted) {
      return false;
    }

    if (item.scope === 'session') {
      return Boolean(sessionId) && item.sessionId === sessionId;
    }

    return true;
  }
}

function extractMemoryCandidates(userText: string, assistantText: string): ExtractedMemory[] {
  const results: ExtractedMemory[] = [];
  const normalizedUser = userText.trim();
  if (normalizedUser.length === 0) {
    return results;
  }

  const preferencePattern = /(prefer|always|never|please use|remember|default to|\u8bf7\u7528|\u4ee5\u540e|\u8bb0\u4f4f|\u9ed8\u8ba4|\u4e0d\u8981|\u5fc5\u987b)/i;
  const rulePattern = /(rule|constraint|must|should|require|\u89c4\u8303|\u7ea6\u675f|\u5fc5\u987b|\u7981\u6b62)/i;

  if (preferencePattern.test(normalizedUser) || rulePattern.test(normalizedUser)) {
    const summary = summarize(normalizedUser, 120);
    const type: MemoryType = rulePattern.test(normalizedUser) ? 'rule' : 'preference';
    const scope: MemoryScope = type === 'rule' ? 'user' : 'session';

    results.push({
      scope,
      type,
      content: normalizeWhitespace(normalizedUser),
      summary,
      keywords: tokenize(normalizedUser),
      confidence: 0.72,
      importance: type === 'rule' ? 0.8 : 0.65,
    });
  }

  const normalizedAssistant = assistantText.trim();
  const fixPattern = /(fixed|resolved|workaround|root cause|\u5df2\u4fee\u590d|\u95ee\u9898\u539f\u56e0|\u89e3\u51b3\u65b9\u6848)/i;
  if (normalizedAssistant.length > 0 && fixPattern.test(normalizedAssistant)) {
    results.push({
      scope: 'session',
      type: 'fix',
      content: summarize(normalizedAssistant, 180),
      summary: summarize(normalizedAssistant, 100),
      keywords: tokenize(normalizedAssistant),
      confidence: 0.6,
      importance: 0.55,
    });
  }

  return dedupeExtracted(results);
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

function scoreItem(item: MemoryItem, queryTokens: string[], now: number): number {
  const haystack = `${item.summary} ${item.content} ${item.keywords.join(' ')}`.toLowerCase();
  const matched = queryTokens.filter((token) => haystack.includes(token));
  const keywordScore = queryTokens.length === 0 ? 0 : matched.length / queryTokens.length;

  const ageDays = Math.max(0, now - item.updatedAt) / (1000 * 60 * 60 * 24);
  const recencyScore = 1 / (1 + ageDays / 7);
  const qualityScore = item.confidence * 0.5 + item.importance * 0.5;

  let score = 0.55 * keywordScore + 0.25 * recencyScore + 0.2 * qualityScore;
  if (item.pinned) {
    score += 0.2;
  }

  if (queryTokens.length === 0) {
    score = recencyScore * 0.7 + qualityScore * 0.3 + (item.pinned ? 0.2 : 0);
  }

  return score;
}

function buildMemoryPrompt(items: MemoryItem[]): string | undefined {
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

function normalizeWhitespace(input: string): string {
  return input.replace(/\s+/g, ' ').trim();
}

function summarize(input: string, maxLength: number): string {
  const compact = normalizeWhitespace(input);
  if (compact.length <= maxLength) {
    return compact;
  }
  return `${compact.slice(0, maxLength - 3)}...`;
}

function normalizeContent(input: string): string {
  return normalizeWhitespace(input).toLowerCase();
}

function tokenize(input: string): string[] {
  return uniqueWords(
    input
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length >= 2)
      .slice(0, 30),
  );
}

function uniqueWords(items: string[]): string[] {
  return [...new Set(items)].slice(0, 40);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
