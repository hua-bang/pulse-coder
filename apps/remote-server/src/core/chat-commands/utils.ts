export function parseListLimit(raw: string | undefined, defaultValue: number, max: number): { ok: true; value: number } | { ok: false; reason: string } {
  if (!raw) {
    return { ok: true, value: defaultValue };
  }

  if (!/^\d+$/.test(raw)) {
    return { ok: false, reason: `会话列表数量必须是 1-${max} 的整数` };
  }

  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > max) {
    return { ok: false, reason: `会话列表数量必须是 1-${max} 的整数` };
  }

  return { ok: true, value };
}

export function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export function estimateMessageTokens(messages: Array<{ role?: unknown; content?: unknown }>): number {
  let totalChars = 0;
  for (const message of messages) {
    totalChars += String(message.role ?? '').length;
    const content = message.content;
    if (typeof content === 'string') {
      totalChars += content.length;
    } else {
      totalChars += safeStringify(content).length;
    }
  }

  return Math.ceil(totalChars / 4);
}

export function parsePositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function getContextWindowTokens(): number {
  return parsePositiveIntEnv('CONTEXT_WINDOW_TOKENS', 64_000);
}

export function getCompactTriggerTokens(): number {
  const fallback = Math.floor(getContextWindowTokens() * 0.75);
  return parsePositiveIntEnv('COMPACT_TRIGGER', fallback);
}

export function getCompactTargetTokens(): number {
  const fallback = Math.floor(getContextWindowTokens() * 0.5);
  return parsePositiveIntEnv('COMPACT_TARGET', fallback);
}

export function getKeepLastTurns(): number {
  return parsePositiveIntEnv('KEEP_LAST_TURNS', 4);
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`;
  }

  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes === 0) {
    return `${seconds}s`;
  }

  return `${minutes}m ${seconds}s`;
}
