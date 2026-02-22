import type { MemoryDailyLogMode, MemoryDailyLogPolicy } from './types.js';

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

function parseBooleanEnv(raw: string | undefined, defaultValue: boolean): boolean {
  const normalized = raw?.trim().toLowerCase();
  if (!normalized) {
    return defaultValue;
  }
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseFloatEnv(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseFloat(raw.trim());
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function parseIntegerEnv(raw: string | undefined): number | undefined {
  if (!raw) {
    return undefined;
  }

  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed)) {
    return undefined;
  }

  return parsed;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.round(clamp(value, min, max));
}
