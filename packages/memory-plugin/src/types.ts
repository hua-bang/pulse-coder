export type MemoryScope = 'session' | 'user';

export type MemoryType = 'preference' | 'rule' | 'decision' | 'fix' | 'fact';

export type MemorySourceType = 'explicit' | 'daily-log';

export type MemoryDailyLogMode = 'write' | 'shadow';

export interface MemoryDailyLogPolicy {
  enabled: boolean;
  mode: MemoryDailyLogMode;
  minConfidence: number;
  maxPerTurn: number;
  maxPerDay: number;
}

export type MemoryCompactionExtractor = 'rule';

export interface MemoryCompactionWritePolicy {
  enabled: boolean;
  minTokenDelta: number;
  minRemovedMessages: number;
  maxPerRun: number;
  extractor: MemoryCompactionExtractor;
}

export interface MemorySourceRef {
  path: string;
  offset: number;
  line: number;
}

export interface MemoryItem {
  id: string;
  platformKey: string;
  sessionId?: string;
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  summary: string;
  keywords: string[];
  confidence: number;
  importance: number;
  pinned: boolean;
  deleted: boolean;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt: number;
  dayKey?: string;
  dedupeKey?: string;
  hitCount?: number;
  firstSeenAt?: number;
  lastSeenAt?: number;
  sourceType?: MemorySourceType;
  chunkId?: string;
  sourceRef?: MemorySourceRef;
}

export interface MemoryState {
  items: MemoryItem[];
  sessionEnabled: Record<string, boolean>;
}

export interface RecallResult {
  enabled: boolean;
  items: MemoryItem[];
  promptAppend?: string;
}

export interface RecordTurnInput {
  platformKey: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  sourceType?: MemorySourceType;
}

export interface RecallInput {
  platformKey: string;
  sessionId: string;
  query: string;
  limit?: number;
}

export interface DailyLogByDayInput {
  platformKey: string;
  sessionId: string;
  dayKey: string;
  limit?: number;
  types?: MemoryType[];
}

export interface ListInput {
  platformKey: string;
  sessionId?: string;
  limit?: number;
}

export interface ToggleResult {
  ok: boolean;
  enabled: boolean;
}

export interface MutateResult {
  ok: boolean;
  reason?: string;
  item?: MemoryItem;
}

export interface EmbeddingProvider {
  dimensions: number;
  embed(text: string): Promise<number[]>;
}

export interface FileMemoryServiceOptions {
  baseDir?: string;
  vectorStorePath?: string;
  maxItemsPerUser?: number;
  defaultRecallLimit?: number;
  semanticRecallEnabled?: boolean;
  embeddingDimensions?: number;
  embeddingProvider?: EmbeddingProvider;
  dailyLogPolicy?: Partial<MemoryDailyLogPolicy>;
  compactionWritePolicy?: Partial<MemoryCompactionWritePolicy>;
}
