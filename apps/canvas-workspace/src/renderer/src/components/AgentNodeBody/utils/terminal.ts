import { Terminal } from '@xterm/xterm';

export const SCROLLBACK_SAVE_INTERVAL = 2000;
export const MAX_SCROLLBACK_CHARS = 50000;

/** localStorage key for recently-used working directories across all agent nodes. */
export const RECENT_CWDS_KEY = 'canvas-workspace:recent-cwds';
export const MAX_RECENT_CWDS = 5;

export const loadRecentCwds = (): string[] => {
  try {
    const raw = localStorage.getItem(RECENT_CWDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export const pushRecentCwd = (cwd: string): string[] => {
  const current = loadRecentCwds().filter((c) => c !== cwd);
  const next = [cwd, ...current].slice(0, MAX_RECENT_CWDS);
  try {
    localStorage.setItem(RECENT_CWDS_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
  return next;
};

export const serializeBuffer = (term: Terminal): string => {
  const buf = term.buffer.active;
  const lines: string[] = [];
  const count = buf.length;
  for (let i = 0; i < count; i++) {
    const line = buf.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  let text = lines.join('\n');
  text = text.replace(/\n+$/, '');
  if (text.length > MAX_SCROLLBACK_CHARS) text = text.slice(-MAX_SCROLLBACK_CHARS);
  return text;
};

/** Truncate a path for display, keeping the last N segments. */
export const truncatePath = (p: string, maxLen = 36): string => {
  if (p.length <= maxLen) return p;
  const parts = p.replace(/\/$/, '').split('/');
  let result = parts[parts.length - 1];
  for (let i = parts.length - 2; i >= 0; i--) {
    const next = parts[i] + '/' + result;
    if (next.length > maxLen) return '\u2026/' + result;
    result = next;
  }
  return result;
};
