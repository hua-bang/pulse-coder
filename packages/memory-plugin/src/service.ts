import BetterSqlite3 from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import type {
  EmbeddingProvider,
  FileMemoryServiceOptions,
  ListInput,
  MemoryDailyLogPolicy,
  MemoryItem,
  MemoryScope,
  MemorySourceType,
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

interface RecallScoreInput {
  keywordScore: number;
  semanticScore: number;
  recencyScore: number;
  qualityScore: number;
  pinned: boolean;
  hasKeywords: boolean;
  hasSemantic: boolean;
}

interface DailyLogWriteStats {
  attempted: number;
  accepted: number;
  deduped: number;
  rejected: number;
  skippedQuota: number;
  rejectedByReason: Record<string, number>;
}

interface StoredEmbeddingRow {
  vector: string;
}

const DEFAULT_EMBEDDING_DIMENSIONS = 256;
const MIN_EMBEDDING_DIMENSIONS = 64;
const MAX_EMBEDDING_DIMENSIONS = 4096;

const DEFAULT_DAILY_LOG_POLICY: MemoryDailyLogPolicy = {
  enabled: true,
  mode: 'write',
  minConfidence: 0.65,
  maxPerTurn: 3,
  maxPerDay: 30,
};

const SEMANTIC_SYNONYMS: Record<string, string[]> = {
  bug: ['issue', 'error', 'defect', 'problem'],
  fix: ['resolve', 'repair', 'patch', 'correct'],
  refactor: ['cleanup', 'restructure', 'rewrite'],
  optimize: ['improve', 'speed', 'performance', 'tune'],
  memory: ['remember', 'recall', 'context'],
  preference: ['prefer', 'default', 'habit'],
  rule: ['constraint', 'must', 'policy', 'guideline'],
};

export class FileMemoryPluginService {
  private readonly baseDir: string;
  private readonly statePath: string;
  private readonly vectorStorePath: string;
  private readonly maxItemsPerUser: number;
  private readonly defaultRecallLimit: number;
  private readonly embeddingProvider: EmbeddingProvider;
  private readonly embeddingDimensions: number;
  private readonly dailyLogPolicy: MemoryDailyLogPolicy;

  private initialized = false;
  private semanticRecallEnabled: boolean;
  private vectorDb?: InstanceType<typeof BetterSqlite3>;
  private state: MemoryState = { items: [], sessionEnabled: {} };

  constructor(options: FileMemoryServiceOptions = {}) {
    this.baseDir = options.baseDir ?? join(homedir(), '.pulse-coder', 'memory-plugin');
    this.statePath = join(this.baseDir, 'state.json');
    this.vectorStorePath = options.vectorStorePath ?? join(this.baseDir, 'vectors.sqlite');
    this.maxItemsPerUser = options.maxItemsPerUser ?? 500;
    this.defaultRecallLimit = options.defaultRecallLimit ?? 5;
    this.semanticRecallEnabled = options.semanticRecallEnabled ?? true;

    const embeddingDimensions = clamp(
      options.embeddingDimensions ?? options.embeddingProvider?.dimensions ?? DEFAULT_EMBEDDING_DIMENSIONS,
      MIN_EMBEDDING_DIMENSIONS,
      MAX_EMBEDDING_DIMENSIONS,
    );
    this.embeddingProvider = options.embeddingProvider ?? new HashEmbeddingProvider(embeddingDimensions);
    this.embeddingDimensions = embeddingDimensions;
    this.dailyLogPolicy = normalizeDailyLogPolicy(options.dailyLogPolicy);
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

    this.initializeVectorStore();
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

    const visibleItems = this.state.items
      .filter((item) => this.isCandidateVisible(item, input.platformKey, input.sessionId));

    const embeddingMap = hasSemanticQuery
      ? this.loadEmbeddings(visibleItems.map((item) => item.id))
      : new Map<string, number[]>();

    const ranked = visibleItems
      .map((item) => {
        const haystack = `${item.summary} ${item.content} ${item.keywords.join(' ')}`.toLowerCase();
        const matched = queryTokens.filter((token) => haystack.includes(token));
        const keywordScore = hasKeywordQuery ? matched.length / queryTokens.length : 0;

        const itemVector = embeddingMap.get(item.id);
        const semanticScore = queryVector && itemVector
          ? cosineSimilarity(queryVector, itemVector)
          : 0;

        const ageDays = Math.max(0, now - item.updatedAt) / (1000 * 60 * 60 * 24);
        const recencyScore = 1 / (1 + ageDays / 7);
        const qualityScore = item.confidence * 0.5 + item.importance * 0.5;

        const score = combineRecallScore({
          keywordScore,
          semanticScore,
          recencyScore,
          qualityScore,
          pinned: item.pinned,
          hasKeywords: hasKeywordQuery,
          hasSemantic: hasSemanticQuery,
        });

        return { item, score };
      })
      .filter((entry) => {
        if (!hasKeywordQuery && !hasSemanticQuery) {
          return true;
        }
        return entry.score >= 0.18;
      })
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
    this.deleteEmbeddings([item.id]);
    return { ok: true, item };
  }

  async recordTurn(input: RecordTurnInput): Promise<void> {
    if (!this.isSessionEnabled(input.platformKey, input.sessionId)) {
      return;
    }

    const extracted = extractMemoryCandidates(input.userText, input.assistantText).slice(0, 6);
    if (extracted.length === 0) {
      return;
    }

    const now = Date.now();
    const sourceType: MemorySourceType = input.sourceType ?? 'explicit';
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

    const dayKey = toDayKey(now);
    let remainingForDay = Math.max(0, this.dailyLogPolicy.maxPerDay - this.countDailyLogEntries(input.platformKey, dayKey));
    let insertedThisTurn = 0;
    const touchedItems: MemoryItem[] = [];
    const stats = createDailyLogWriteStats();

    for (const candidate of extracted) {
      stats.attempted += 1;

      if (!isAllowedDailyLogType(candidate.type)) {
        recordDailyLogRejection(stats, 'type_not_allowed');
        continue;
      }

      const rejection = evaluateDailyLogQualityGate(candidate, this.dailyLogPolicy.minConfidence);
      if (rejection) {
        recordDailyLogRejection(stats, rejection);
        continue;
      }

      const dedupeKey = buildDailyLogDedupeKey(candidate);
      const duplicate = this.state.items.find((item) => {
        if (item.platformKey !== input.platformKey || item.deleted) {
          return false;
        }

        return item.sourceType === 'daily-log'
          && item.sessionId === input.sessionId
          && item.dayKey === dayKey
          && item.dedupeKey === dedupeKey;
      });

      if (duplicate) {
        stats.accepted += 1;
        stats.deduped += 1;

        if (this.dailyLogPolicy.mode === 'shadow') {
          continue;
        }

        duplicate.updatedAt = now;
        duplicate.lastAccessedAt = now;
        duplicate.confidence = Math.max(duplicate.confidence, candidate.confidence);
        duplicate.importance = Math.max(duplicate.importance, candidate.importance);
        duplicate.keywords = uniqueWords([...duplicate.keywords, ...candidate.keywords]);
        duplicate.summary = summarize(`${duplicate.summary} ${candidate.summary}`, 120);
        duplicate.sourceType = 'daily-log';
        duplicate.dayKey = dayKey;
        duplicate.dedupeKey = dedupeKey;
        duplicate.firstSeenAt = duplicate.firstSeenAt ?? duplicate.createdAt;
        duplicate.lastSeenAt = now;
        duplicate.hitCount = (duplicate.hitCount ?? 1) + 1;
        touchedItems.push(duplicate);
        continue;
      }

      if (insertedThisTurn >= this.dailyLogPolicy.maxPerTurn) {
        recordDailyLogRejection(stats, 'quota_turn');
        stats.skippedQuota += 1;
        continue;
      }

      if (remainingForDay <= 0) {
        recordDailyLogRejection(stats, 'quota_day');
        stats.skippedQuota += 1;
        continue;
      }

      stats.accepted += 1;
      insertedThisTurn += 1;
      remainingForDay -= 1;

      if (this.dailyLogPolicy.mode === 'shadow') {
        continue;
      }

      const nextItem: MemoryItem = {
        id: randomUUID().slice(0, 8),
        platformKey: input.platformKey,
        sessionId: input.sessionId,
        scope: 'session',
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
        sourceType: 'daily-log',
        dayKey,
        dedupeKey,
        hitCount: 1,
        firstSeenAt: now,
        lastSeenAt: now,
      };
      this.state.items.push(nextItem);
      touchedItems.push(nextItem);
    }

    if (stats.attempted > 0) {
      const rejectSummary = formatDailyLogRejectReasons(stats.rejectedByReason);
      const extra = rejectSummary ? ` rejectReasons=${rejectSummary}` : '';
      console.info(
        `[memory-plugin] daily-log mode=${this.dailyLogPolicy.mode} platform=${input.platformKey} session=${input.sessionId} attempted=${stats.attempted} accepted=${stats.accepted} deduped=${stats.deduped} rejected=${stats.rejected} skippedQuota=${stats.skippedQuota}${extra}`,
      );
    }

    if (this.dailyLogPolicy.mode === 'shadow' || touchedItems.length === 0) {
      return;
    }

    await this.commitTouchedItems(input.platformKey, touchedItems);
  }

  private async commitTouchedItems(platformKey: string, touchedItems: MemoryItem[]): Promise<void> {
    if (touchedItems.length === 0) {
      return;
    }

    const compactedIds = this.compact(platformKey);
    await this.saveState();

    await Promise.all(
      touchedItems.map(async (item) => {
        await this.upsertEmbedding(item);
      }),
    );
    this.deleteEmbeddings(compactedIds);
  }

  private countDailyLogEntries(platformKey: string, dayKey: string): number {
    return this.state.items.filter((item) => {
      if (item.platformKey !== platformKey || item.deleted) {
        return false;
      }

      return item.sourceType === 'daily-log' && item.dayKey === dayKey;
    }).length;
  }

  private initializeVectorStore(): void {
    if (!this.semanticRecallEnabled) {
      return;
    }

    try {
      const db = new BetterSqlite3(this.vectorStorePath);
      db.pragma('journal_mode = WAL');
      db.exec(`
        CREATE TABLE IF NOT EXISTS memory_vectors (
          memory_id TEXT PRIMARY KEY,
          platform_key TEXT NOT NULL,
          vector TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_vectors_platform_key ON memory_vectors(platform_key);
      `);
      this.vectorDb = db;
    } catch (error) {
      this.semanticRecallEnabled = false;
      this.vectorDb = undefined;
      console.warn('[memory-plugin] semantic recall disabled: failed to initialize vector store', error);
    }
  }

  private async backfillMissingEmbeddings(): Promise<void> {
    if (!this.semanticRecallEnabled || !this.vectorDb) {
      return;
    }

    let existing = new Set<string>();
    try {
      const rows = this.vectorDb
        .prepare('SELECT memory_id FROM memory_vectors')
        .all() as Array<{ memory_id: string }>;
      existing = new Set(rows.map((row) => row.memory_id));
    } catch {
      return;
    }

    const missing = this.state.items.filter((item) => !item.deleted && !existing.has(item.id));
    for (const item of missing) {
      await this.upsertEmbedding(item);
    }

    const deletedIds = this.state.items.filter((item) => item.deleted).map((item) => item.id);
    this.deleteEmbeddings(deletedIds);
  }

  private loadEmbeddings(memoryIds: string[]): Map<string, number[]> {
    const result = new Map<string, number[]>();
    if (!this.semanticRecallEnabled || !this.vectorDb || memoryIds.length === 0) {
      return result;
    }

    const stmt = this.vectorDb.prepare('SELECT vector FROM memory_vectors WHERE memory_id = ?') as {
      get: (memoryId: string) => StoredEmbeddingRow | undefined;
    };

    for (const memoryId of memoryIds) {
      const row = stmt.get(memoryId);
      if (!row) {
        continue;
      }
      const vector = parseEmbedding(row.vector, this.embeddingDimensions);
      if (vector) {
        result.set(memoryId, vector);
      }
    }

    return result;
  }

  private async upsertEmbedding(item: MemoryItem): Promise<void> {
    if (!this.semanticRecallEnabled || !this.vectorDb || item.deleted) {
      return;
    }

    const text = [item.type, item.summary, item.content, item.keywords.join(' ')].filter(Boolean).join(' ');
    const embedding = await this.embedText(text);
    if (!embedding) {
      return;
    }

    const stmt = this.vectorDb.prepare(`
      INSERT INTO memory_vectors (memory_id, platform_key, vector, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET
        platform_key = excluded.platform_key,
        vector = excluded.vector,
        updated_at = excluded.updated_at
    `);

    stmt.run(item.id, item.platformKey, JSON.stringify(embedding), Date.now());
  }

  private deleteEmbeddings(memoryIds: string[]): void {
    if (!this.semanticRecallEnabled || !this.vectorDb || memoryIds.length === 0) {
      return;
    }

    const stmt = this.vectorDb.prepare('DELETE FROM memory_vectors WHERE memory_id = ?');
    for (const memoryId of new Set(memoryIds)) {
      stmt.run(memoryId);
    }
  }

  private async embedText(text: string): Promise<number[] | undefined> {
    if (!this.semanticRecallEnabled) {
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
    await fs.writeFile(this.statePath, JSON.stringify(this.state, null, 2), 'utf-8');
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
}

export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly dimensions: number;

  constructor(dimensions: number) {
    this.dimensions = clamp(dimensions, MIN_EMBEDDING_DIMENSIONS, MAX_EMBEDDING_DIMENSIONS);
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

function extractMemoryCandidates(userText: string, assistantText: string): ExtractedMemory[] {
  const results: ExtractedMemory[] = [];
  const normalizedUser = userText.trim();

  if (normalizedUser.length > 0) {
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
  }

  const normalizedAssistant = assistantText.trim();
  if (normalizedAssistant.length > 0) {
    const fixPattern = /(fixed|resolved|workaround|root cause|\u5df2\u4fee\u590d|\u95ee\u9898\u539f\u56e0|\u89e3\u51b3\u65b9\u6848)/i;
    if (fixPattern.test(normalizedAssistant)) {
      results.push({
        scope: 'session',
        type: 'fix',
        content: summarize(normalizedAssistant, 180),
        summary: summarize(normalizedAssistant, 100),
        keywords: tokenize(normalizedAssistant),
        confidence: 0.7,
        importance: 0.65,
      });
    }

    const decisionPattern = /(decide|decision|choose|selected|we will|plan is|adopt|\u91c7\u7528|\u51b3\u5b9a|\u65b9\u6848\u662f)/i;
    if (decisionPattern.test(normalizedAssistant)) {
      results.push({
        scope: 'session',
        type: 'decision',
        content: summarize(normalizedAssistant, 180),
        summary: summarize(normalizedAssistant, 100),
        keywords: tokenize(normalizedAssistant),
        confidence: 0.68,
        importance: 0.62,
      });
    }
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

function toDayKey(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function buildDailyLogDedupeKey(candidate: ExtractedMemory): string {
  const normalized = normalizeContent(candidate.summary || candidate.content);
  return `${candidate.type}:${normalized.slice(0, 160)}`;
}

function isAllowedDailyLogType(type: MemoryType): boolean {
  return type === 'rule' || type === 'decision' || type === 'fix' || type === 'fact';
}

function evaluateDailyLogQualityGate(candidate: ExtractedMemory, minConfidence: number): string | undefined {
  if (candidate.confidence < minConfidence) {
    return 'low_confidence';
  }

  const compact = normalizeWhitespace(candidate.content);
  if (compact.length < 18) {
    return 'too_short';
  }

  if (looksLikeSmallTalk(compact)) {
    return 'small_talk';
  }

  const tokenCount = tokenize(compact).length;
  if (tokenCount < 3) {
    return 'low_density';
  }

  return undefined;
}

function looksLikeSmallTalk(content: string): boolean {
  return /^(ok|okay|thanks|thank you|got it|sure|nice|yes|no|\u597d\u7684|\u6536\u5230|\u660e\u767d\u4e86|\u884c|\u55ef+|\u554a+|\u54c8+)[!. ]*$/i.test(content);
}

function createDailyLogWriteStats(): DailyLogWriteStats {
  return {
    attempted: 0,
    accepted: 0,
    deduped: 0,
    rejected: 0,
    skippedQuota: 0,
    rejectedByReason: {},
  };
}

function recordDailyLogRejection(stats: DailyLogWriteStats, reason: string): void {
  stats.rejected += 1;
  stats.rejectedByReason[reason] = (stats.rejectedByReason[reason] ?? 0) + 1;
}

function formatDailyLogRejectReasons(reasons: Record<string, number>): string {
  return Object.entries(reasons)
    .map(([reason, count]) => `${reason}:${count}`)
    .join(',');
}

function normalizeDailyLogPolicy(input?: Partial<MemoryDailyLogPolicy>): MemoryDailyLogPolicy {
  const mode = input?.mode === 'shadow' ? 'shadow' : 'write';

  return {
    enabled: input?.enabled ?? DEFAULT_DAILY_LOG_POLICY.enabled,
    mode,
    minConfidence: clamp(input?.minConfidence ?? DEFAULT_DAILY_LOG_POLICY.minConfidence, 0, 1),
    maxPerTurn: Math.max(1, Math.round(input?.maxPerTurn ?? DEFAULT_DAILY_LOG_POLICY.maxPerTurn)),
    maxPerDay: Math.max(1, Math.round(input?.maxPerDay ?? DEFAULT_DAILY_LOG_POLICY.maxPerDay)),
  };
}

function combineRecallScore(input: RecallScoreInput): number {
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

function normalizeEmbeddingVector(vector: number[], dimensions: number): number[] {
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

function parseEmbedding(raw: string, dimensions: number): number[] | undefined {
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

function cosineSimilarity(left: number[], right: number[]): number {
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
  return clamp(cosine, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
