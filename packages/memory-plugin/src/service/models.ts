import type { MemoryScope, MemoryType } from '../types.js';

export interface ExtractedMemory {
  scope: MemoryScope;
  type: MemoryType;
  content: string;
  summary: string;
  keywords: string[];
  confidence: number;
  importance: number;
}

export interface RecallScoreInput {
  keywordScore: number;
  semanticScore: number;
  recencyScore: number;
  qualityScore: number;
  pinned: boolean;
  hasKeywords: boolean;
  hasSemantic: boolean;
}

export interface DailyLogWriteStats {
  attempted: number;
  accepted: number;
  deduped: number;
  rejected: number;
  skippedQuota: number;
  rejectedByReason: Record<string, number>;
}
