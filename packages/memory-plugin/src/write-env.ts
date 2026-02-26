import type { MemoryCompactionExtractor, MemoryCompactionWritePolicy, MemoryDailyLogMode, MemoryDailyLogPolicy } from './types.js';
import {
  clamp,
  clampInteger,
  parseBooleanEnv,
  parseFloatEnv,
  parseIntegerEnv,
} from './config/env-utils.js';

export interface MemoryWriteRuntimeConfig {
  dailyLogPolicy: MemoryDailyLogPolicy;
  compactionWritePolicy: MemoryCompactionWritePolicy;
}

const DEFAULT_DAILY_LOG_POLICY: MemoryDailyLogPolicy = {
  enabled: true,
  mode: 'write',
  minConfidence: 0.65,
  maxPerTurn: 3,
  maxPerDay: 30,
};

const DEFAULT_COMPACTION_WRITE_POLICY: MemoryCompactionWritePolicy = {
  enabled: true,
  minTokenDelta: 8000,
  minRemovedMessages: 4,
  maxPerRun: 1,
  extractor: 'rule',
};

export function resolveMemoryWriteRuntimeConfigFromEnv(
  env: Record<string, string | undefined> = process.env,
): MemoryWriteRuntimeConfig {
  const enabled = parseBooleanEnv(env.MEMORY_DAILY_LOG_ENABLED, DEFAULT_DAILY_LOG_POLICY.enabled);
  const mode = parseDailyLogMode(env.MEMORY_DAILY_LOG_MODE, DEFAULT_DAILY_LOG_POLICY.mode);
  const minConfidence = clamp(
    parseFloatEnv(env.MEMORY_DAILY_LOG_MIN_CONFIDENCE) ?? DEFAULT_DAILY_LOG_POLICY.minConfidence,
    0,
    1,
  );
  const maxPerTurn = clampInteger(
    parseIntegerEnv(env.MEMORY_DAILY_LOG_MAX_PER_TURN) ?? DEFAULT_DAILY_LOG_POLICY.maxPerTurn,
    1,
    20,
  );
  const maxPerDay = clampInteger(
    parseIntegerEnv(env.MEMORY_DAILY_LOG_MAX_PER_DAY) ?? DEFAULT_DAILY_LOG_POLICY.maxPerDay,
    1,
    200,
  );

  const compactionEnabled = parseBooleanEnv(
    env.MEMORY_COMPACTION_WRITE_ENABLED,
    DEFAULT_COMPACTION_WRITE_POLICY.enabled,
  );
  const compactionMinTokenDelta = clampInteger(
    parseIntegerEnv(env.MEMORY_COMPACTION_MIN_TOKEN_DELTA) ?? DEFAULT_COMPACTION_WRITE_POLICY.minTokenDelta,
    1,
    200000,
  );
  const compactionMinRemovedMessages = clampInteger(
    parseIntegerEnv(env.MEMORY_COMPACTION_MIN_REMOVED_MESSAGES) ?? DEFAULT_COMPACTION_WRITE_POLICY.minRemovedMessages,
    1,
    200,
  );
  const compactionMaxPerRun = clampInteger(
    parseIntegerEnv(env.MEMORY_COMPACTION_MAX_PER_RUN) ?? DEFAULT_COMPACTION_WRITE_POLICY.maxPerRun,
    1,
    10,
  );
  const compactionExtractor = parseCompactionExtractor(
    env.MEMORY_COMPACTION_EXTRACTOR,
    DEFAULT_COMPACTION_WRITE_POLICY.extractor,
  );

  return {
    dailyLogPolicy: {
      enabled,
      mode,
      minConfidence,
      maxPerTurn,
      maxPerDay,
    },
    compactionWritePolicy: {
      enabled: compactionEnabled,
      minTokenDelta: compactionMinTokenDelta,
      minRemovedMessages: compactionMinRemovedMessages,
      maxPerRun: compactionMaxPerRun,
      extractor: compactionExtractor,
    },
  };
}

function parseDailyLogMode(raw: string | undefined, fallback: MemoryDailyLogMode): MemoryDailyLogMode {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'shadow') {
    return 'shadow';
  }
  if (normalized === 'write') {
    return 'write';
  }
  return fallback;
}

function parseCompactionExtractor(
  raw: string | undefined,
  fallback: MemoryCompactionExtractor,
): MemoryCompactionExtractor {
  const normalized = raw?.trim().toLowerCase();
  if (normalized === 'rule') {
    return 'rule';
  }
  return fallback;
}
