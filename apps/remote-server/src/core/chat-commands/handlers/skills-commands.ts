import type { CommandResult } from '../types.js';
import { getSkillRegistry } from '../services.js';
import { buildSkillListMessage, resolveSkillSelection } from '../skill-utils.js';

export function handleSkillsCommand(args: string[]): CommandResult {
  const registry = getSkillRegistry();
  if (!registry) {
    return {
      type: 'handled',
      message: '⚠️ skill registry 不可用，请确认内置 skills 插件已启用。',
    };
  }

  const skills = [...registry.getAll()].sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length === 0) {
    return {
      type: 'handled',
      message: '📭 当前未加载任何技能。请在 `.pulse-coder/skills/**/SKILL.md` 添加技能后重试。',
    };
  }

  const subCommand = args[0]?.toLowerCase();
  if (!subCommand || subCommand === 'list') {
    return {
      type: 'handled',
      message: buildSkillListMessage(skills),
    };
  }

  if (subCommand === 'current' || subCommand === 'clear' || subCommand === 'off' || subCommand === 'none') {
    return {
      type: 'handled',
      message: 'ℹ️ 技能是单次生效。请使用 `/skills <name|index> <message>` 触发一次技能消息。',
    };
  }

  let selectionTokens = args;
  if (subCommand === 'use') {
    selectionTokens = args.slice(1);
  }

  if (selectionTokens.length < 2) {
    return {
      type: 'handled',
      message: '❌ 请同时提供 skill 和 message\n用法：/skills <name|index> <message>',
    };
  }

  const skillTarget = selectionTokens[0];
  const selected = resolveSkillSelection(skillTarget, skills);
  if (!selected) {
    return {
      type: 'handled',
      message: `❌ 未找到技能：${skillTarget}\n可用命令：/skills list`,
    };
  }

  const message = selectionTokens.slice(1).join(' ').trim();
  if (!message) {
    return {
      type: 'handled',
      message: '❌ message 不能为空\n用法：/skills <name|index> <message>',
    };
  }

  return {
    type: 'transformed',
    text: `[use skill](${selected.name}) ${message}`,
  };
}
