import type { MemoryDailyLogMode, MemoryDailyLogPolicy } from './types.js';
import {
  clamp,
  clampInteger,
  parseBooleanEnv,
  parseFloatEnv,
  parseIntegerEnv,
} from './config/env-utils.js';

export interface MemoryWriteRuntimeConfig {
  dailyLogPolicy: MemoryDailyLogPolicy;
}

const DEFAULT_DAILY_LOG_POLICY: MemoryDailyLogPolicy = {
  enabled: true,
  mode: 'write',
  minConfidence: 0.65,
  maxPerTurn: 3,
  maxPerDay: 30,
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

  return {
    dailyLogPolicy: {
      enabled,
      mode,
      minConfidence,
      maxPerTurn,
      maxPerDay,
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
