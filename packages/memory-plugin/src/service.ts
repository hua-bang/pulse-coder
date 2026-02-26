import { randomUUID } from 'crypto';
import { homedir } from 'os';
import { join } from 'path';
import {
  HashEmbeddingProvider,
  MAX_EMBEDDING_DIMENSIONS,
  MIN_EMBEDDING_DIMENSIONS,
  cosineSimilarity,
  normalizeEmbeddingVector,
} from './embedding/hash-provider.js';
import {
  deleteEmbeddings,
  initializeVectorStore,
  listStoredEmbeddingIds,
  loadEmbeddings,
  upsertEmbedding,
  type VectorStore,
} from './embedding/vector-store.js';
import { formatDailyLogLogLine, normalizeDailyLogPolicy, processDailyLogCandidates } from './service/daily-log.js';
import { extractMemoryCandidates } from './service/extraction.js';
import type { ExtractedMemory } from './service/models.js';
import { buildMemoryPrompt } from './service/recall.js';
import { LayeredMemoryStateStore } from './service/state-store.js';
import type {
  EmbeddingProvider,
  FileMemoryServiceOptions,
  ListInput,
  MemoryDailyLogPolicy,
  MemoryItem,
  MemorySourceType,
  MemoryState,
  MutateResult,
  RecallInput,
  RecallResult,
  RecordTurnInput,
  ToggleResult,
} from './types.js';
import { clamp, normalizeContent, normalizeWhitespace, tokenize, uniqueWords } from './utils/text.js';

const DEFAULT_EMBEDDING_DIMENSIONS = 256;
const HYBRID_TOPK_MULTIPLIER = 3;
const VECTOR_WEIGHT = 0.65;
const KEYWORD_WEIGHT = 0.35;

interface RankedCandidate {
  item: MemoryItem;
  vectorScore: number;
  keywordScore: number;
  recencyScore: number;
  qualityScore: number;
}

export class FileMemoryPluginService {
  private readonly stateStore: LayeredMemoryStateStore;
  private readonly vectorStorePath: string;
  private readonly maxItemsPerUser: number;
  private readonly defaultRecallLimit: number;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly embeddingDimensions: number;
  private readonly dailyLogPolicy: MemoryDailyLogPolicy;

  private initialized = false;
  private vectorStore: VectorStore;
  private state: MemoryState = { items: [], sessionEnabled: {} };

  constructor(options: FileMemoryServiceOptions = {}) {
    const baseDir = options.baseDir ?? join(homedir(), '.pulse-coder', 'memory-plugin');
    this.stateStore = new LayeredMemoryStateStore(baseDir);
    this.vectorStorePath = options.vectorStorePath ?? join(baseDir, 'vectors.sqlite');
    this.maxItemsPerUser = options.maxItemsPerUser ?? 500;
    this.defaultRecallLimit = options.defaultRecallLimit ?? 5;

    const embeddingDimensions = clamp(
      options.embeddingDimensions ?? options.embeddingProvider?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
      MIN_EMBEDDING_DIMENSIONS,
      MAX_EMBEDDING_DIMENSIONS,
    );
    this.embeddingProvider = options.embeddingProvider ?? new HashEmbeddingProvider(embeddingDimensions);
    this.embeddingDimensions = embeddingDimensions;
    this.dailyLogPolicy = normalizeDailyLogPolicy(options.dailyLogPolicy);

    this.vectorStore = {
      semanticRecallEnabled: options.semanticRecallEnabled ?? true,
      db: undefined,
    };
  }

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const loaded = await this.stateStore.loadMergedState();
    this.state = loaded.state;

    if (loaded.legacyPath) {
      await this.stateStore.saveState(this.state);
      await this.stateStore.backupLegacyState(loaded.legacyPath);
    }

    this.vectorStore = initializeVectorStore(this.vectorStorePath, this.vectorStore.semanticRecallEnabled);
    await this.backfillMissingEmbeddings();

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
    const hasKeywordQuery = queryTokens.length > 0;
    const queryVector = await this.embedText(input.query);
    const hasSemanticQuery = Boolean(queryVector);
    const now = Date.now();

    const timeFilter = resolveRecallTimeFilter(input.query, now);
    let visibleItems = this.state.items
      .filter((item) => this.isCandidateVisible(item, input.platformKey, input.sessionId))
      .filter((item) => item.sourceType === 'daily-log');

    if (timeFilter) {
      visibleItems = visibleItems.filter((item) => isItemInRecallTimeFilter(item, timeFilter));
    }

    if (visibleItems.length === 0) {
      return {
        enabled,
        items: [],
        promptAppend: undefined,
      };
    }

    const embeddingMap = hasSemanticQuery
      ? loadEmbeddings(this.vectorStore, visibleItems.map((item) => item.id), this.embeddingDimensions)
      : new Map<string, number[]>();

    const topK = Math.max(limit, limit * HYBRID_TOPK_MULTIPLIER);
    const merged = new Map<string, RankedCandidate>();

    if (hasSemanticQuery && queryVector) {
      const semanticTop = visibleItems
        .map((item) => {
          const itemVector = embeddingMap.get(item.id);
          const vectorScore = itemVector ? cosineSimilarity(queryVector, itemVector) : 0;
          return { item, vectorScore };
        })
        .filter((entry) => entry.vectorScore > 0)
        .sort((a, b) => b.vectorScore - a.vectorScore)
        .slice(0, topK);

      for (const entry of semanticTop) {
        merged.set(entry.item.id, {
          item: entry.item,
          vectorScore: entry.vectorScore,
          keywordScore: 0,
          recencyScore: this.buildRecencyScore(now, entry.item),
          qualityScore: this.buildQualityScore(entry.item),
        });
      }
    }

    if (hasKeywordQuery) {
      const keywordTop = visibleItems
        .map((item) => {
          const haystack = `${item.summary} ${item.content} ${item.keywords.join(' ')}`.toLowerCase();
          const matched = queryTokens.filter((token) => haystack.includes(token));
          return {
            item,
            keywordScore: matched.length / queryTokens.length,
          };
        })
        .filter((entry) => entry.keywordScore > 0)
        .sort((a, b) => b.keywordScore - a.keywordScore)
        .slice(0, topK);

      for (const entry of keywordTop) {
        const existing = merged.get(entry.item.id);
        if (existing) {
          existing.keywordScore = Math.max(existing.keywordScore, entry.keywordScore);
          continue;
        }

        merged.set(entry.item.id, {
          item: entry.item,
          vectorScore: 0,
          keywordScore: entry.keywordScore,
          recencyScore: this.buildRecencyScore(now, entry.item),
          qualityScore: this.buildQualityScore(entry.item),
        });
      }
    }

    if (merged.size === 0) {
      const fallback = visibleItems
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, topK);

      for (const item of fallback) {
        merged.set(item.id, {
          item,
          vectorScore: 0,
          keywordScore: 0,
          recencyScore: this.buildRecencyScore(now, item),
          qualityScore: this.buildQualityScore(item),
        });
      }
    }

    const ranked = [...merged.values()]
      .sort((a, b) => this.sortHybrid(a, b, hasKeywordQuery || hasSemanticQuery))
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
    deleteEmbeddings(this.vectorStore, [item.id]);
    return { ok: true, item };
  }

  async recordTurn(input: RecordTurnInput): Promise<void> {
    if (!this.isSessionEnabled(input.platformKey, input.sessionId)) {
      return;
    }

    const now = Date.now();
    const sourceType: MemorySourceType = input.sourceType ?? 'explicit';
    const extracted = extractMemoryCandidates(input.userText, input.assistantText, {
      sourceType,
      platformKey: input.platformKey,
      sessionId: input.sessionId,
      now,
    }).slice(0, 6);
    if (extracted.length === 0) {
      return;
    }

    if (sourceType === 'daily-log') {
      await this.recordDailyLogTurn(input, extracted, now);
      return;
    }

    await this.recordExplicitTurn(input, extracted.slice(0, 3), now);
  }

  private async recordExplicitTurn(input: RecordTurnInput, extracted: ExtractedMemory[], now: number): Promise<void> {
    const touchedItems: MemoryItem[] = [];

    for (const candidate of extracted) {
      const duplicate = this.state.items.find((item) => {
        if (item.platformKey !== input.platformKey || item.deleted || item.sourceType === 'daily-log') {
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
        duplicate.sourceType = duplicate.sourceType ?? 'explicit';
        duplicate.chunkId = candidate.chunkId ?? duplicate.chunkId;
        duplicate.sourceRef = candidate.sourceRef ?? duplicate.sourceRef;
        touchedItems.push(duplicate);
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
        sourceType: 'explicit',
        chunkId: candidate.chunkId,
        sourceRef: candidate.sourceRef,
      };
      this.state.items.push(nextItem);
      touchedItems.push(nextItem);
    }

    await this.commitTouchedItems(input.platformKey, touchedItems);
  }

  private async recordDailyLogTurn(input: RecordTurnInput, extracted: ExtractedMemory[], now: number): Promise<void> {
    if (!this.dailyLogPolicy.enabled) {
      return;
    }

    const result = processDailyLogCandidates({
      platformKey: input.platformKey,
      sessionId: input.sessionId,
      stateItems: this.state.items,
      policy: this.dailyLogPolicy,
      now,
    }, extracted);

    if (result.stats.attempted > 0) {
      console.info(formatDailyLogLogLine(input.platformKey, input.sessionId, result.mode, result.stats));
    }

    if (result.mode === 'shadow' || result.touchedItems.length === 0) {
      return;
    }

    await this.commitTouchedItems(input.platformKey, result.touchedItems);
  }

  private async commitTouchedItems(platformKey: string, touchedItems: MemoryItem[]): Promise<void> {
    if (touchedItems.length === 0) {
      return;
    }

    const compactedIds = this.compact(platformKey);
    await this.saveState();

    await Promise.all(
      touchedItems.map(async (item) => {
        const embedding = await this.buildItemEmbedding(item);
        upsertEmbedding(this.vectorStore, item, embedding);
      }),
    );
    deleteEmbeddings(this.vectorStore, compactedIds);
  }

  private async backfillMissingEmbeddings(): Promise<void> {
    if (!this.vectorStore.semanticRecallEnabled || !this.vectorStore.db) {
      return;
    }

    const existing = listStoredEmbeddingIds(this.vectorStore);
    if (!existing) {
      return;
    }
    const missing = this.state.items.filter((item) => !item.deleted && !existing.has(item.id));
    for (const item of missing) {
      const embedding = await this.buildItemEmbedding(item);
      upsertEmbedding(this.vectorStore, item, embedding);
    }

    const deletedIds = this.state.items.filter((item) => item.deleted).map((item) => item.id);
    deleteEmbeddings(this.vectorStore, deletedIds);
  }

  private async buildItemEmbedding(item: MemoryItem): Promise<number[] | undefined> {
    const text = [item.type, item.summary, item.content, item.keywords.join(' ')].filter(Boolean).join(' ');
    return this.embedText(text);
  }

  private async embedText(text: string): Promise<number[] | undefined> {
    if (!this.vectorStore.semanticRecallEnabled) {
      return undefined;
    }

    const compact = normalizeWhitespace(text);
    if (!compact) {
      return undefined;
    }

    try {
      const vector = await this.embeddingProvider.embed(compact);
      return normalizeEmbeddingVector(vector, this.embeddingDimensions);
    } catch {
      return undefined;
    }
  }

  private async saveState(): Promise<void> {
    await this.stateStore.saveState(this.state);
  }

  private sessionKey(platformKey: string, sessionId: string): string {
    return `${platformKey}:${sessionId}`;
  }

  private compact(platformKey: string): string[] {
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
      return [];
    }

    const droppedIds = active.slice(this.maxItemsPerUser).map((item) => item.id);
    const toDrop = new Set(droppedIds);

    this.state.items = this.state.items.filter((item) => {
      if (item.platformKey !== platformKey) {
        return true;
      }
      return !toDrop.has(item.id);
    });

    return droppedIds;
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

  private buildRecencyScore(now: number, item: MemoryItem): number {
    const ageDays = Math.max(0, now - item.updatedAt) / (1000 * 60 * 60 * 24);
    return 1 / (1 + ageDays / 7);
  }

  private buildQualityScore(item: MemoryItem): number {
    return item.confidence * 0.5 + item.importance * 0.5;
  }

  private hybridScore(entry: RankedCandidate, hasQuerySignal: boolean): number {
    if (!hasQuerySignal) {
      return entry.recencyScore * 0.8 + entry.qualityScore * 0.2;
    }

    const hybrid = entry.vectorScore * VECTOR_WEIGHT + entry.keywordScore * KEYWORD_WEIGHT;
    return hybrid + entry.recencyScore * 0.05 + entry.qualityScore * 0.02 + (entry.item.pinned ? 0.2 : 0);
  }

  private sortHybrid(a: RankedCandidate, b: RankedCandidate, hasQuerySignal: boolean): number {
    const scoreA = this.hybridScore(a, hasQuerySignal);
    const scoreB = this.hybridScore(b, hasQuerySignal);
    if (scoreA !== scoreB) {
      return scoreB - scoreA;
    }
    return b.item.updatedAt - a.item.updatedAt;
  }
}

interface RecallTimeFilter {
  dayKeys: Set<string>;
}

function resolveRecallTimeFilter(query: string, now: number): RecallTimeFilter | undefined {
  const normalized = normalizeWhitespace(query).toLowerCase();
  if (!normalized) {
    return undefined;
  }

  const today = toDayKey(now);
  const days = new Set<string>();

  if (/\bday before yesterday\b/.test(normalized) || normalized.includes('前天')) {
    days.add(shiftDayKey(today, -2));
  }

  if (/\byesterday\b/.test(normalized) || normalized.includes('昨天')) {
    days.add(shiftDayKey(today, -1));
  }

  if (/\btoday\b/.test(normalized) || normalized.includes('今天')) {
    days.add(today);
  }

  const cnRecentMatch = normalized.match(/最近\s*(\d+)\s*天/);
  if (cnRecentMatch) {
    const raw = Number.parseInt(cnRecentMatch[1], 10);
    if (Number.isFinite(raw)) {
      for (const day of collectRecentDayKeys(today, raw)) {
        days.add(day);
      }
    }
  }

  const enRecentMatch = normalized.match(/\blast\s*(\d+)\s*days?\b/);
  if (enRecentMatch) {
    const raw = Number.parseInt(enRecentMatch[1], 10);
    if (Number.isFinite(raw)) {
      for (const day of collectRecentDayKeys(today, raw)) {
        days.add(day);
      }
    }
  }

  return days.size > 0 ? { dayKeys: days } : undefined;
}

function isItemInRecallTimeFilter(item: MemoryItem, filter: RecallTimeFilter): boolean {
  return Boolean(item.dayKey && filter.dayKeys.has(item.dayKey));
}

function collectRecentDayKeys(todayDayKey: string, rawDays: number): string[] {
  const days = clamp(Math.round(rawDays), 1, 30);
  const collected: string[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    collected.push(shiftDayKey(todayDayKey, -offset));
  }
  return collected;
}

function shiftDayKey(dayKey: string, dayOffset: number): string {
  const date = new Date(`${dayKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + dayOffset);
  return toDayKey(date.getTime());
}

function toDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

export { HashEmbeddingProvider };
