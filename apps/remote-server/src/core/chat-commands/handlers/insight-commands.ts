import type { CommandResult } from '../types.js';

export function handleInsightCommand(args: string[]): CommandResult {
  const raw = args[0]?.trim();
  const days = parseInsightDays(raw);
  if (raw && !days.ok) {
    return {
      type: 'handled',
      message: '❌ 用法：/insight [days]\n示例：/insight 7\n说明：days 取值 1-365，默认 7。',
    };
  }

  const value = days.ok ? days.value : 7;
  const text = [
    `[use skill](session-digest) Summarize and extract insights from my sessions in the last ${value} days.`,
    'Focus on recurring themes, key decisions, and actionable next steps.',
  ].join(' ');

  return {
    type: 'transformed',
    text,
  };
}

function parseInsightDays(raw: string | undefined): { ok: true; value: number } | { ok: false } {
  if (!raw) {
    return { ok: false };
  }

  if (!/^\d+$/.test(raw)) {
    return { ok: false };
  }

  const value = Number.parseInt(raw, 10);
  if (value < 1 || value > 365) {
    return { ok: false };
  }

  return { ok: true, value };
}
