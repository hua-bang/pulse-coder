import { randomUUID } from 'crypto';
import type { DailyLogWriteStats, ExtractedMemory } from './models.js';
import type { MemoryDailyLogPolicy, MemoryItem, MemoryType } from '../types.js';
import { normalizeContent, normalizeWhitespace, summarize, tokenize, uniqueWords } from '../utils/text.js';

const DEFAULT_DAILY_LOG_POLICY: MemoryDailyLogPolicy = {
  enabled: true,
  mode: 'write',
  minConfidence: 0.65,
  maxPerTurn: 3,
  maxPerDay: 30,
};

export interface DailyLogContext {
  platformKey: string;
  sessionId: string;
  stateItems: MemoryItem[];
  policy: MemoryDailyLogPolicy;
  now: number;
}

export interface DailyLogProcessResult {
  touchedItems: MemoryItem[];
  stats: DailyLogWriteStats;
  mode: MemoryDailyLogPolicy['mode'];
}

export function normalizeDailyLogPolicy(input?: Partial<MemoryDailyLogPolicy>): MemoryDailyLogPolicy {
  const mode = input?.mode === 'shadow' ? 'shadow' : 'write';

  return {
    enabled: input?.enabled ?? DEFAULT_DAILY_LOG_POLICY.enabled,
    mode,
    minConfidence: clamp(input?.minConfidence ?? DEFAULT_DAILY_LOG_POLICY.minConfidence, 0, 1),
    maxPerTurn: Math.max(1, Math.round(input?.maxPerTurn ?? DEFAULT_DAILY_LOG_POLICY.maxPerTurn)),
    maxPerDay: Math.max(1, Math.round(input?.maxPerDay ?? DEFAULT_DAILY_LOG_POLICY.maxPerDay)),
  };
}

export function processDailyLogCandidates(
  context: DailyLogContext,
  extracted: ExtractedMemory[],
): DailyLogProcessResult {
  const dayKey = toDayKey(context.now);
  let remainingForDay = Math.max(0, context.policy.maxPerDay - countDailyLogEntries(context.stateItems, context.platformKey, dayKey));
  let insertedThisTurn = 0;
  const touchedItems: MemoryItem[] = [];
  const stats = createDailyLogWriteStats();

  for (const candidate of extracted) {
    stats.attempted += 1;

    if (!isAllowedDailyLogType(candidate.type)) {
      recordDailyLogRejection(stats, 'type_not_allowed');
      continue;
    }

    const rejection = evaluateDailyLogQualityGate(candidate, context.policy.minConfidence);
    if (rejection) {
      recordDailyLogRejection(stats, rejection);
      continue;
    }

    const dedupeKey = buildDailyLogDedupeKey(candidate);
    const duplicate = context.stateItems.find((item) => {
      if (item.platformKey !== context.platformKey || item.deleted) {
        return false;
      }

      return item.sourceType === 'daily-log'
        && item.sessionId === context.sessionId
        && item.dayKey === dayKey
        && item.dedupeKey === dedupeKey;
    });

    if (duplicate) {
      stats.accepted += 1;
      stats.deduped += 1;

      if (context.policy.mode === 'shadow') {
        continue;
      }

      duplicate.updatedAt = context.now;
      duplicate.lastAccessedAt = context.now;
      duplicate.confidence = Math.max(duplicate.confidence, candidate.confidence);
      duplicate.importance = Math.max(duplicate.importance, candidate.importance);
      duplicate.keywords = uniqueWords([...duplicate.keywords, ...candidate.keywords]);
      duplicate.summary = summarize(`${duplicate.summary} ${candidate.summary}`, 120);
      duplicate.sourceType = 'daily-log';
      duplicate.dayKey = dayKey;
      duplicate.dedupeKey = dedupeKey;
      duplicate.firstSeenAt = duplicate.firstSeenAt ?? duplicate.createdAt;
      duplicate.lastSeenAt = context.now;
      duplicate.hitCount = (duplicate.hitCount ?? 1) + 1;
      duplicate.chunkId = candidate.chunkId ?? duplicate.chunkId;
      duplicate.sourceRef = candidate.sourceRef ?? duplicate.sourceRef;
      touchedItems.push(duplicate);
      continue;
    }

    if (insertedThisTurn >= context.policy.maxPerTurn) {
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

    if (context.policy.mode === 'shadow') {
      continue;
    }

    const nextItem: MemoryItem = {
      id: randomUUID().slice(0, 8),
      platformKey: context.platformKey,
      sessionId: context.sessionId,
      scope: 'session',
      type: candidate.type,
      content: candidate.content,
      summary: candidate.summary,
      keywords: candidate.keywords,
      confidence: candidate.confidence,
      importance: candidate.importance,
      pinned: false,
      deleted: false,
      createdAt: context.now,
      updatedAt: context.now,
      lastAccessedAt: context.now,
      sourceType: 'daily-log',
      dayKey,
      dedupeKey,
      hitCount: 1,
      firstSeenAt: context.now,
      lastSeenAt: context.now,
      chunkId: candidate.chunkId,
      sourceRef: candidate.sourceRef,
    };
    context.stateItems.push(nextItem);
    touchedItems.push(nextItem);
  }

  return {
    touchedItems,
    stats,
    mode: context.policy.mode,
  };
}

export function formatDailyLogLogLine(
  platformKey: string,
  sessionId: string,
  mode: MemoryDailyLogPolicy['mode'],
  stats: DailyLogWriteStats,
): string {
  const rejectSummary = formatDailyLogRejectReasons(stats.rejectedByReason);
  const extra = rejectSummary ? ` rejectReasons=${rejectSummary}` : '';
  return `[memory-plugin] daily-log mode=${mode} platform=${platformKey} session=${sessionId} attempted=${stats.attempted} accepted=${stats.accepted} deduped=${stats.deduped} rejected=${stats.rejected} skippedQuota=${stats.skippedQuota}${extra}`;
}

function countDailyLogEntries(items: MemoryItem[], platformKey: string, dayKey: string): number {
  return items.filter((item) => {
    if (item.platformKey !== platformKey || item.deleted) {
      return false;
    }

    return item.sourceType === 'daily-log' && item.dayKey === dayKey;
  }).length;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
