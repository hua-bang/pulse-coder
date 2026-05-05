import type { SkillSummary } from '../../core/chat-commands/types.js';
import { getSkillRegistry } from '../../core/chat-commands/services.js';

export const DISCORD_SKILLS_SELECT_CUSTOM_ID = 'pulse.skills.select';
export const DISCORD_SKILLS_MODAL_CUSTOM_ID_PREFIX = 'pulse.skills.modal:';
export const DISCORD_SKILLS_PROMPT_INPUT_ID = 'prompt';

const DISCORD_SELECT_MENU_OPTION_LIMIT = 25;
const DISCORD_SELECT_LABEL_LIMIT = 100;
const DISCORD_SELECT_VALUE_LIMIT = 100;
const DISCORD_SELECT_DESCRIPTION_LIMIT = 100;
const DISCORD_MODAL_TITLE_LIMIT = 45;
const DISCORD_TEXT_INPUT_LABEL_LIMIT = 45;
const DISCORD_TEXT_INPUT_MAX_LENGTH = 1800;

export interface DiscordSelectOption {
  label: string;
  value: string;
  description?: string;
}

export interface DiscordComponent {
  type: number;
  custom_id?: string;
  placeholder?: string;
  min_values?: number;
  max_values?: number;
  options?: DiscordSelectOption[];
  label?: string;
  style?: number;
  min_length?: number;
  max_length?: number;
  required?: boolean;
  value?: string;
  components?: DiscordComponent[];
}

export interface DiscordInteractionResponseMessageData {
  content: string;
  flags?: number;
  components?: DiscordComponent[];
}

export interface DiscordModalResponseData {
  custom_id: string;
  title: string;
  components: DiscordComponent[];
}

export function buildDiscordSkillsSelectMessage(flags?: number): DiscordInteractionResponseMessageData {
  const registry = getSkillRegistry();
  if (!registry) {
    return {
      content: '⚠️ skill registry 不可用，请确认内置 skills 插件已启用。',
      flags,
    };
  }

  const skills = [...registry.getAll()].sort((a, b) => a.name.localeCompare(b.name));
  if (skills.length === 0) {
    return {
      content: '📭 当前未加载任何技能。请在 `.pulse-coder/skills/**/SKILL.md` 添加技能后重试。',
      flags,
    };
  }

  const shownSkills = skills.slice(0, DISCORD_SELECT_MENU_OPTION_LIMIT);
  const suffix = skills.length > shownSkills.length
    ? `\n\n-# 当前先平铺展示前 ${shownSkills.length}/${skills.length} 个技能，后续可继续做分类/分页。`
    : '';

  return {
    content: `🧰 Skill Launcher\n请选择一个 skill，然后在弹窗里输入要交给它处理的需求。${suffix}`,
    flags,
    components: [
      {
        type: 1,
        components: [
          {
            type: 3,
            custom_id: DISCORD_SKILLS_SELECT_CUSTOM_ID,
            placeholder: '选择一个 skill',
            min_values: 1,
            max_values: 1,
            options: shownSkills.map(toSelectOption),
          },
        ],
      },
    ],
  };
}

export function buildDiscordSkillPromptModal(skillName: string): DiscordModalResponseData | null {
  const skill = resolveSkillByName(skillName);
  if (!skill) {
    return null;
  }

  return {
    custom_id: `${DISCORD_SKILLS_MODAL_CUSTOM_ID_PREFIX}${skill.name}`,
    title: clip(`Use ${skill.name}`, DISCORD_MODAL_TITLE_LIMIT),
    components: [
      {
        type: 1,
        components: [
          {
            type: 4,
            custom_id: DISCORD_SKILLS_PROMPT_INPUT_ID,
            label: clip('输入要交给该 skill 的需求', DISCORD_TEXT_INPUT_LABEL_LIMIT),
            style: 2,
            min_length: 1,
            max_length: DISCORD_TEXT_INPUT_MAX_LENGTH,
            required: true,
            placeholder: '例如：帮我整理今天的日程和待办',
          },
        ],
      },
    ],
  };
}

export function isDiscordSkillsSelectCustomId(customId: string | undefined): boolean {
  return customId === DISCORD_SKILLS_SELECT_CUSTOM_ID;
}

export function getDiscordSkillsModalSkillName(customId: string | undefined): string | null {
  if (!customId?.startsWith(DISCORD_SKILLS_MODAL_CUSTOM_ID_PREFIX)) {
    return null;
  }

  const skillName = customId.slice(DISCORD_SKILLS_MODAL_CUSTOM_ID_PREFIX.length).trim();
  return skillName || null;
}

export function extractDiscordComponentTextValue(
  components: DiscordComponent[] | undefined,
  customId: string,
): string {
  if (!components) {
    return '';
  }

  for (const component of components) {
    if (component.custom_id === customId && typeof component.value === 'string') {
      return component.value.trim();
    }

    const nested = extractDiscordComponentTextValue(component.components, customId);
    if (nested) {
      return nested;
    }
  }

  return '';
}

function resolveSkillByName(skillName: string): SkillSummary | null {
  const registry = getSkillRegistry();
  if (!registry) {
    return null;
  }

  return registry.get(skillName) ?? null;
}

function toSelectOption(skill: SkillSummary): DiscordSelectOption {
  return {
    label: clip(skill.name, DISCORD_SELECT_LABEL_LIMIT),
    value: clip(skill.name, DISCORD_SELECT_VALUE_LIMIT),
    description: clip(skill.description || 'No description', DISCORD_SELECT_DESCRIPTION_LIMIT),
  };
}

function clip(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  if (maxLength <= 1) {
    return normalized.slice(0, maxLength);
  }

  return `${normalized.slice(0, maxLength - 1)}…`;
}
