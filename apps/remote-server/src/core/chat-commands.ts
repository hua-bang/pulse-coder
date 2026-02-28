import { engine } from './engine-singleton.js';
import { sessionStore } from './session-store.js';
import type { IncomingMessage } from './types.js';
import { memoryService } from './memory-integration.js';
import { abortActiveRun, getActiveRun } from './active-run-store.js';

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
  | { type: 'handled_silent' }
  | { type: 'transformed'; text: string };

const COMMANDS_ALLOWED_WHILE_RUNNING = new Set(['help', 'start', 'status', 'stop', 'current', 'ping', 'memory', 'fork']);
const COMMAND_ALIASES: Record<string, string> = {
  '?': 'help',
  h: 'help',
  restart: 'new',
  reset: 'clear',
  cancel: 'stop',
  halt: 'stop',
  ls: 'sessions',
  session: 'current',
  mem: 'memory',
  clone: 'fork',
};
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
      message: '⚠️ 请输入命令，例如 `/new`、`/clear`、`/compact`、`/resume`、`/fork`、`/memory`、`/status`、`/stop`、`/skills`。',
    };
  }

  const command = normalizeCommand(tokens[0].toLowerCase());
  const args = tokens.slice(1);
  const memoryKey = incoming.memoryKey ?? incoming.platformKey;

  const activeRun = getActiveRun(incoming.platformKey);
  if (activeRun && !COMMANDS_ALLOWED_WHILE_RUNNING.has(command)) {
    return {
      type: 'handled',
      message: '⏳ 当前正在处理上一条消息，请稍候或使用 `/status` 查看进度、`/stop` 停止任务。',
    };
  }

  switch (command) {
    case 'help':
    case 'start':
      return { type: 'handled', message: buildHelpMessage() };

    case 'new': {
      const sessionId = await sessionStore.createNewSession(incoming.platformKey, memoryKey);
      return {
        type: 'handled',
        message: `✅ 已创建新会话\nSession ID: ${sessionId}`,
      };
    }

    case 'clear': {
      const result = await sessionStore.clearCurrent(incoming.platformKey, memoryKey);
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
    case 'sessions':
      return await handleResumeCommand(incoming.platformKey, args);

    case 'fork':
      return await handleForkCommand(incoming.platformKey, memoryKey, args);

    case 'status':
      return await handleStatusCommand(incoming.platformKey);

    case 'current':
      return await handleCurrentSessionCommand(incoming.platformKey);

    case 'stop':
      return handleStopCommand(incoming.platformKey);

    case 'detach':
      return await handleDetachCommand(incoming.platformKey);

    case 'ping':
      return {
        type: 'handled',
        message: '🏓 pong',
      };

    case 'skills':
      return handleSkillsCommand(args);

    case 'compact':
      return await handleCompactCommand(incoming.platformKey);

    case 'memory':
      return await handleMemoryCommand(incoming.platformKey, memoryKey, args);

    default:
      return {
        type: 'handled',
        message: `⚠️ 未知命令: /${command}\n\n${buildHelpMessage()}`,
      };
  }
}

async function handleResumeCommand(platformKey: string, args: string[]): Promise<CommandResult> {
  const firstArg = args[0]?.toLowerCase();
  const listRequested = args.length === 0
    || firstArg === 'list'
    || firstArg === 'ls'
    || /^\d+$/.test(firstArg ?? '');

  if (listRequested) {
    const limitArg = args.length === 0
      ? undefined
      : (/^\d+$/.test(firstArg ?? '') ? args[0] : args[1]);
    const limitResult = parseListLimit(limitArg, 10, 30);
    if (!limitResult.ok) {
      return {
        type: 'handled',
        message: `❌ ${limitResult.reason}\n用法：/resume [list] [1-30]`,
      };
    }

    const currentSessionId = sessionStore.getCurrentSessionId(platformKey);
    const sessions = await sessionStore.listSessions(platformKey, limitResult.value);

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
      message: `📚 你的历史会话（最近 ${sessions.length} / ${limitResult.value} 条）：\n${lines.join('\n')}\n\n用法：/resume <session-id>`,
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

async function handleForkCommand(platformKey: string, memoryKey: string, args: string[]): Promise<CommandResult> {
  const sourceSessionId = args[0]?.trim();
  if (!sourceSessionId) {
    return {
      type: 'handled',
      message: '❌ 缺少 session-id\n用法：/fork <session-id>',
    };
  }

  const result = await sessionStore.forkSession(platformKey, sourceSessionId, memoryKey);
  if (!result.ok || !result.sessionId) {
    return {
      type: 'handled',
      message: `❌ 无法 fork 会话：${result.reason ?? '未知错误'}\n用法：/fork <session-id>`,
    };
  }

  return {
    type: 'handled',
    message: [
      '🌱 已基于历史会话创建分叉会话',
      `- Source Session ID: ${result.sourceSessionId ?? sourceSessionId}`,
      `- New Session ID: ${result.sessionId}`,
      `- 复制消息数：${result.messageCount ?? 0}`,
      '- 当前已自动切换到新会话。',
    ].join('\n'),
  };
}

async function handleStatusCommand(platformKey: string): Promise<CommandResult> {
  const activeRun = getActiveRun(platformKey);
  const sessionStatus = await sessionStore.getCurrentStatus(platformKey);

  const lines: string[] = ['📊 当前状态：'];

  if (activeRun) {
    lines.push(`- 运行状态：处理中（已运行 ${formatDuration(Date.now() - activeRun.startedAt)}）`);
    lines.push(`- Stream ID: ${activeRun.streamId}`);
  } else {
    lines.push('- 运行状态：空闲');
  }

  if (sessionStatus) {
    lines.push(`- 当前会话：${sessionStatus.sessionId}`);
    lines.push(`- 消息数：${sessionStatus.messageCount}`);
    lines.push(`- 最后更新：${formatTime(sessionStatus.updatedAt)}`);
  } else {
    lines.push('- 当前会话：无（发送普通消息会自动创建）');
  }

  return {
    type: 'handled',
    message: lines.join('\n'),
  };
}

async function handleCurrentSessionCommand(platformKey: string): Promise<CommandResult> {
  const sessionStatus = await sessionStore.getCurrentStatus(platformKey);
  if (!sessionStatus) {
    return {
      type: 'handled',
      message: 'ℹ️ 当前没有已绑定会话。发送普通消息会自动创建新会话。',
    };
  }

  return {
    type: 'handled',
    message: [
      '🧭 当前会话：',
      `- Session ID: ${sessionStatus.sessionId}`,
      `- 消息数：${sessionStatus.messageCount}`,
      `- 创建时间：${formatTime(sessionStatus.createdAt)}`,
      `- 最后更新：${formatTime(sessionStatus.updatedAt)}`,
    ].join('\n'),
  };
}

function handleStopCommand(platformKey: string): CommandResult {
  const result = abortActiveRun(platformKey);
  if (!result.aborted) {
    return {
      type: 'handled',
      message: 'ℹ️ 当前没有正在运行的任务。',
    };
  }

  // No extra command response; the in-flight run will finish as "stopped"
  // on its original stream handle.
  return {
    type: 'handled_silent',
  };
}

async function handleDetachCommand(platformKey: string): Promise<CommandResult> {
  const currentSessionId = sessionStore.getCurrentSessionId(platformKey);
  if (!currentSessionId) {
    return {
      type: 'handled',
      message: 'ℹ️ 当前没有已绑定会话。',
    };
  }

  await sessionStore.detach(platformKey);
  return {
    type: 'handled',
    message: `🪄 已断开会话绑定：${currentSessionId}\n发送普通消息会自动创建新会话。`,
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
  const beforeTokens = estimateMessageTokens(current.context.messages);
  const compactTrigger = getCompactTriggerTokens();
  const compactTarget = getCompactTargetTokens();
  const keepLastTurns = getKeepLastTurns();

  try {
    const compactResult = await engine.compactContext(current.context, { force: true });

    if (!compactResult.didCompact || !compactResult.newMessages) {
      return {
        type: 'handled',
        message: [
          'ℹ️ 本次没有触发压缩。',
          `- 消息数: ${beforeCount}`,
          `- 估算 tokens: ~${beforeTokens}`,
          `- 压缩阈值(触发/目标): ${compactTrigger}/${compactTarget}`,
          `- KEEP_LAST_TURNS: ${keepLastTurns}`,
          `- 原因: ${compactResult.reason ?? 'not-triggered'}`,
        ].join('\n'),
      };
    }

    current.context.messages = compactResult.newMessages;
    await sessionStore.save(current.sessionId, current.context);

    const afterCount = current.context.messages.length;
    const afterTokens = estimateMessageTokens(current.context.messages);
    const messageDelta = beforeCount - afterCount;
    const tokenDelta = beforeTokens - afterTokens;

    return {
      type: 'handled',
      message: [
        '🧩 已压缩上下文',
        `- 消息数: ${beforeCount} -> ${afterCount} (减少 ${messageDelta})`,
        `- 估算 tokens: ~${beforeTokens} -> ~${afterTokens} (减少 ~${tokenDelta})`,
        `- 压缩阈值(触发/目标): ${compactTrigger}/${compactTarget}`,
        `- KEEP_LAST_TURNS: ${keepLastTurns}`,
        `- 原因: ${compactResult.reason ?? 'force-compact'}`,
      ].join('\n'),
    };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    return {
      type: 'handled',
      message: `❌ 压缩失败: ${errorMessage}`,
    };
  }
}


async function handleMemoryCommand(platformKey: string, memoryKey: string, args: string[]): Promise<CommandResult> {
  const sub = args[0]?.toLowerCase() ?? 'list';
  const currentSessionId = sessionStore.getCurrentSessionId(platformKey);

  if (sub === 'on' || sub === 'off') {
    if (!currentSessionId) {
      return {
        type: 'handled',
        message: 'ℹ️ 当前没有会话，先发送一条普通消息创建会话后再设置 memory 开关。',
      };
    }

    const enabled = sub === 'on';
    await memoryService.setSessionEnabled(memoryKey, currentSessionId, enabled);
    return {
      type: 'handled',
      message: enabled
        ? `🧠 已开启当前会话 memory\nSession ID: ${currentSessionId}`
        : `🧠 已关闭当前会话 memory\nSession ID: ${currentSessionId}`,
    };
  }

  if (sub === 'pin') {
    const id = args[1];
    if (!id) {
      return {
        type: 'handled',
        message: '❌ 缺少 memory id\n用法：/memory pin <id>',
      };
    }

    const result = await memoryService.pin(memoryKey, id);
    if (!result.ok) {
      return {
        type: 'handled',
        message: `❌ pin 失败：${result.reason ?? 'unknown error'}`,
      };
    }

    return {
      type: 'handled',
      message: `📌 已置顶 memory: ${id}`,
    };
  }

  if (sub === 'forget' || sub === 'delete' || sub === 'rm') {
    const id = args[1];
    if (!id) {
      return {
        type: 'handled',
        message: '❌ 缺少 memory id\n用法：/memory forget <id>',
      };
    }

    const result = await memoryService.forget(memoryKey, id);
    if (!result.ok) {
      return {
        type: 'handled',
        message: `❌ forget 失败：${result.reason ?? 'unknown error'}`,
      };
    }

    return {
      type: 'handled',
      message: `🗑️ 已删除 memory: ${id}`,
    };
  }

  if (sub === 'status') {
    const enabled = currentSessionId ? memoryService.isSessionEnabled(memoryKey, currentSessionId) : true;
    const list = await memoryService.list({ platformKey: memoryKey, sessionId: currentSessionId, limit: 1 });
    return {
      type: 'handled',
      message: [
        '🧠 Memory 状态：',
        `- 会话开关：${enabled ? 'on' : 'off'}`,
        `- 当前会话：${currentSessionId ?? '无'}`,
        `- 可见 memory：${list.length > 0 ? '>= 1' : '0'}`,
      ].join('\n'),
    };
  }

  const list = await memoryService.list({
    platformKey: memoryKey,
    sessionId: currentSessionId,
    limit: 10,
  });

  const enabled = currentSessionId ? memoryService.isSessionEnabled(memoryKey, currentSessionId) : true;

  if (list.length === 0) {
    return {
      type: 'handled',
      message: [
        '📭 当前暂无 memory。',
        `- 会话开关：${enabled ? 'on' : 'off'}`,
        '- 你可以通过包含偏好/规则的消息让系统自动学习。',
        '- 用法：/memory | /memory on | /memory off | /memory pin <id> | /memory forget <id>',
      ].join('\n'),
    };
  }

  const lines = list.map((item, index) => {
    const marker = item.pinned ? '📌' : '  ';
    return `${index + 1}. ${marker} [${item.id}] (${item.type}/${item.scope}) ${item.summary}`;
  });

  return {
    type: 'handled',
    message: [
      `🧠 Memory 列表（${list.length} 条，可见范围）`,
      `- 会话开关：${enabled ? 'on' : 'off'}`,
      ...lines,
      '',
      '用法：/memory on | /memory off | /memory pin <id> | /memory forget <id>',
    ].join('\n'),
  };
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
    '/help - 查看命令帮助',
    '/ping - 检查机器人在线状态',
    '/new - 创建新会话',
    '/restart - /new 的别名',
    '/clear - 清空当前会话上下文',
    '/reset - /clear 的别名',
    '/compact - 强制压缩当前会话上下文',
    '/memory - 查看 memory 列表',
    '/memory on|off - 开关当前会话 memory',
    '/memory pin <id> - 置顶一条 memory',
    '/memory forget <id> - 删除一条 memory',
    '/current - 查看当前绑定会话',
    '/detach - 断开当前会话绑定（不删除历史）',
    '/resume - 查看历史会话（最近 10 条）',
    '/resume [list] [N] - 查看最近 N 条历史会话（N 范围 1-30）',
    '/sessions - /resume 的别名',
    '/resume <session-id> - 恢复指定会话',
    '/fork <session-id> - 基于指定会话创建新分叉会话并自动切换',
    '/status - 查看当前运行状态与会话信息',
    '/stop - 停止当前正在运行的任务',
    '/cancel - /stop 的别名',
    '/skills list - 查看可用技能',
    '/skills <name|index> <message> - 用指定技能执行一条消息',
  ].join('\n');
}

function normalizeCommand(command: string): string {
  return COMMAND_ALIASES[command] ?? command;
}

function parseListLimit(raw: string | undefined, defaultValue: number, max: number): { ok: true; value: number } | { ok: false; reason: string } {
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

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function estimateMessageTokens(messages: Array<{ role?: unknown; content?: unknown }>): number {
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

function parsePositiveIntEnv(name: string, fallback: number): number {
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

function getContextWindowTokens(): number {
  return parsePositiveIntEnv('CONTEXT_WINDOW_TOKENS', 64_000);
}

function getCompactTriggerTokens(): number {
  const fallback = Math.floor(getContextWindowTokens() * 0.75);
  return parsePositiveIntEnv('COMPACT_TRIGGER', fallback);
}

function getCompactTargetTokens(): number {
  const fallback = Math.floor(getContextWindowTokens() * 0.5);
  return parsePositiveIntEnv('COMPACT_TARGET', fallback);
}

function getKeepLastTurns(): number {
  return parsePositiveIntEnv('KEEP_LAST_TURNS', 4);
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString();
}

function formatDuration(ms: number): string {
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
