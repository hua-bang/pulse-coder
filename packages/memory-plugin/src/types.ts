export type MemoryScope = 'session' | 'user';

export type MemoryType = 'preference' | 'rule' | 'decision' | 'fix' | 'fact';

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
}

export interface RecallInput {
  platformKey: string;
  sessionId: string;
  query: string;
  limit?: number;
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
}
