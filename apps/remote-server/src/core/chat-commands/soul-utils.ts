import type { SoulSummary } from './types.js';

export function buildSoulListMessage(souls: SoulSummary[], state?: { activeSoulIds: string[] } | null): string {
  if (souls.length === 0) {
    return '📭 当前没有可用的 soul。';
  }

  const active = state?.activeSoulIds?.length ? new Set(state.activeSoulIds.map((id) => id.toLowerCase())) : new Set<string>();
  const lines = souls.map((soul, index) => {
    const isActive = active.has(soul.id.toLowerCase());
    const marker = isActive ? '🎭' : '  ';
    const desc = soul.description ? ` - ${soul.description}` : '';
    return `${String(index + 1).padStart(2, ' ')}. ${marker} ${soul.id}${desc}`;
  });

  const header = state?.activeSoulIds?.length
    ? `🎭 已启用 soul：${state.activeSoulIds.join(', ')}`
    : '🎭 当前未启用 soul';

  return [
    header,
    '🧩 可用 soul：',
    ...lines,
    '',
    '用法：/soul list | /soul use <id> | /soul add <id> | /soul remove <id> | /soul clear',
  ].join('\n');
}
