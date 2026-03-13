import type { SkillSummary } from './types.js';

export function resolveSkillSelection(target: string, skills: SkillSummary[]): SkillSummary | null {
  const trimmed = target.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d+$/.test(trimmed)) {
    const index = Number.parseInt(trimmed, 10);
    if (index >= 1 && index <= skills.length) {
      return skills[index - 1];
    }
    return null;
  }

  const lower = trimmed.toLowerCase();
  const exact = skills.find((skill) => skill.name.toLowerCase() === lower);
  if (exact) {
    return exact;
  }

  const fuzzy = skills.filter((skill) => skill.name.toLowerCase().includes(lower));
  if (fuzzy.length === 1) {
    return fuzzy[0];
  }

  return null;
}

export function buildSkillListMessage(skills: SkillSummary[]): string {
  const lines = skills.map((skill, index) => `${String(index + 1).padStart(2, ' ')}. ${skill.name} - ${skill.description}`);
  return `🧰 可用技能：\n${lines.join('\n')}\n\n用法：/skills <name|index> <message>`;
}
