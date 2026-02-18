import { engine } from './engine-singleton.js';
import { sessionStore } from './session-store.js';
import type { IncomingMessage } from './types.js';

interface SkillSummary {
  name: string;
  description: string;
}

interface SkillRegistryService {
  getAll: () => SkillSummary[];
  get: (name: string) => SkillSummary | undefined;
}

export type CommandResult =
  | { type: 'none' }
  | { type: 'handled'; message: string }
  | { type: 'transformed'; text: string };

/**
 * Parse and execute slash commands for remote chat channels.
 */
export async function processIncomingCommand(incoming: IncomingMessage): Promise<CommandResult> {
  const raw = incoming.text.trim();
  if (!raw.startsWith('/')) {
    return { type: 'none' };
  }

  const tokens = raw.slice(1).split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return {
      type: 'handled',
      message: '⚠️ 请输入命令，例如 `/new`、`/clear`、`/compact`、`/resume`、`/skills`。',
    };
  }

  const command = tokens[0].toLowerCase();
  const args = tokens.slice(1);

  switch (command) {
    case 'help':
    case 'start':
      return { type: 'handled', message: buildHelpMessage() };

    case 'new': {
      const sessionId = await sessionStore.createNewSession(incoming.platformKey);
      return {
        type: 'handled',
        message: `✅ 已创建新会话\nSession ID: ${sessionId}`,
      };
    }

    case 'clear': {
      const result = await sessionStore.clearCurrent(incoming.platformKey);
      if (result.createdNew) {
        return {
          type: 'handled',
          message: `🧹 当前无可清空会话，已新建会话\nSession ID: ${result.sessionId}`,
        };
      }

      return {
        type: 'handled',
        message: `🧹 已清空当前会话上下文\nSession ID: ${result.sessionId}`,
      };
    }

    case 'resume':
      return await handleResumeCommand(incoming.platformKey, args);

    case 'skills':
      return handleSkillsCommand(args);

    case 'compact':
      return await handleCompactCommand(incoming.platformKey);

    default:
      return {
        type: 'handled',
        message: `⚠️ 未知命令: /${command}\n\n${buildHelpMessage()}`,
      };
  }
}

async function handleResumeCommand(platformKey: string, args: string[]): Promise<CommandResult> {
  if (args.length === 0) {
    const currentSessionId = sessionStore.getCurrentSessionId(platformKey);
    const sessions = await sessionStore.listSessions(platformKey, 10);

    if (sessions.length === 0) {
      return {
        type: 'handled',
        message: '📭 暂无可恢复会话。发送普通消息即可自动创建新会话。',
      };
    }

    const lines = sessions.map((session, index) => {
      const marker = session.id === currentSessionId ? '✅' : '  ';
      const preview = session.preview.length > 80 ? `${session.preview.slice(0, 80)}...` : session.preview;
      return `${index + 1}. ${marker} ${session.id} | ${session.messageCount} 条消息 | ${formatTime(session.updatedAt)}\n   ${preview}`;
    });

    return {
      type: 'handled',
      message: `📚 你的历史会话（最近 10 条）：\n${lines.join('\n')}\n\n用法：/resume <session-id>`,
    };
  }

  const sessionId = args[0];
  const result = await sessionStore.attach(platformKey, sessionId);
  if (!result.ok) {
    return {
      type: 'handled',
      message: `❌ 无法恢复会话：${result.reason ?? '未知错误'}\n用法：/resume <session-id>`,
    };
  }

  return {
    type: 'handled',
    message: `✅ 已恢复会话：${sessionId}`,
  };
}


async function handleCompactCommand(platformKey: string): Promise<CommandResult> {
  const current = await sessionStore.getCurrent(platformKey);
  if (!current) {
    return {
      type: 'handled',
      message: 'ℹ️ 当前没有可压缩的会话。先发送一条普通消息开始会话。',
    };
  }

  if (current.context.messages.length === 0) {
    return {
      type: 'handled',
      message: 'ℹ️ 当前会话为空，无需压缩。',
    };
  }

  const beforeCount = current.context.messages.length;

  try {
    const compactResult = await engine.compactContext(current.context, { force: true });

    if (!compactResult.didCompact || !compactResult.newMessages) {
      return {
        type: 'handled',
        message: 'ℹ️ 本次没有触发压缩。',
      };
    }

    current.context.messages = compactResult.newMessages;
    await sessionStore.save(current.sessionId, current.context);

    const reasonSuffix = compactResult.reason ? `（原因: ${compactResult.reason}）` : '';
    return {
      type: 'handled',
      message: `🧩 已压缩上下文: ${beforeCount} -> ${current.context.messages.length} 条消息${reasonSuffix}`,
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      type: 'handled',
      message: `❌ 压缩失败: ${errorMessage}`,
    };
  }
}

function handleSkillsCommand(args: string[]): CommandResult {
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

function getSkillRegistry(): SkillRegistryService | undefined {
  return engine.getService<SkillRegistryService>('skillRegistry');
}

function resolveSkillSelection(target: string, skills: SkillSummary[]): SkillSummary | null {
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

function buildSkillListMessage(skills: SkillSummary[]): string {
  const lines = skills.map((skill, index) => `${String(index + 1).padStart(2, ' ')}. ${skill.name} - ${skill.description}`);
  return `🧰 可用技能：\n${lines.join('\n')}\n\n用法：/skills <name|index> <message>`;
}

function buildHelpMessage(): string {
  return [
    '📋 可用命令：',
    '/new - 创建新会话',
    '/clear - 清空当前会话上下文',
    '/compact - 强制压缩当前会话上下文',
    '/resume - 查看历史会话（最近 10 条）',
    '/resume <session-id> - 恢复指定会话',
    '/skills list - 查看可用技能',
    '/skills <name|index> <message> - 用指定技能执行一条消息',
  ].join('\n');
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}
