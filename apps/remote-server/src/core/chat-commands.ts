import type { IncomingMessage } from './types.js';
import { handlePm2RestartCommand } from './restart-command.js';
import { processWorktreeCommand } from './worktree/commands.js';
import { buildRemoteWorktreeRunContext } from './worktree/integration.js';
import { COMMANDS_ALLOWED_WHILE_RUNNING, normalizeCommand } from './chat-commands/command-defs.js';
import { buildHelpMessage } from './chat-commands/help.js';
import type { CommandResult } from './chat-commands/types.js';
import {
  handleClearCommand,
  handleCompactCommand,
  handleCurrentSessionCommand,
  handleMergeCommand,
  handleDetachCommand,
  handleForkCommand,
  handleNewCommand,
  handlePingCommand,
  handleResumeCommand,
  handleStatusCommand,
  handleStopCommand,
} from './chat-commands/handlers/session-commands.js';
import { handleMemoryCommand } from './chat-commands/handlers/memory-commands.js';
import { handleModeCommand } from './chat-commands/handlers/mode-commands.js';
import { handleModelCommand } from './chat-commands/handlers/model-commands.js';
import { handleInsightCommand } from './chat-commands/handlers/insight-commands.js';
import { handleSkillsCommand } from './chat-commands/handlers/skills-commands.js';
import { handleSoulCommand } from './chat-commands/handlers/soul-commands.js';
import { handleAcpCommand } from './chat-commands/handlers/acp-commands.js';
import { getAcpState } from 'pulse-coder-acp';
import { getActiveRun } from './active-run-store.js';

/**
 * Parse and execute slash commands for remote chat channels.
 */
export async function processIncomingCommand(incoming: IncomingMessage): Promise<CommandResult> {
  const raw = incoming.text.trim();
  if (!raw.startsWith('/')) {
    return { type: 'none' };
  }

  // //cmd → force-forward to ACP agent (strips one slash, e.g. //clear → /clear)
  if (raw.startsWith('//')) {
    const acpState = await getAcpState(incoming.platformKey);
    if (acpState) {
      return { type: 'transformed', text: raw.slice(1) };
    }
  }

  const tokens = raw.slice(1).split(/\s+/).filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return {
      type: 'handled',
      message: '⚠️ 请输入命令，例如 `/new`、`/clear`、`/compact`、`/resume`、`/fork`、`/merge`、`/memory`、`/status`、`/stop`、`/skills`、`/wt`。',
    };
  }

  const command = normalizeCommand(tokens[0].toLowerCase());
  const args = tokens.slice(1);
  const memoryKey = incoming.memoryKey ?? incoming.platformKey;
  const activeRun = getActiveRun(incoming.platformKey);

  const worktreeContext = buildRemoteWorktreeRunContext(incoming.platformKey);
  const worktreeCommand = await processWorktreeCommand({
    text: raw,
    runtimeKey: worktreeContext.runtimeKey,
    scopeKey: worktreeContext.scopeKey,
  });
  if (worktreeCommand.handled) {
    return {
      type: 'handled',
      message: worktreeCommand.message ?? '✅ 已处理 worktree 命令。',
    };
  }
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

    case 'new':
      return await handleNewCommand(incoming.platformKey, memoryKey);

    case 'restart':
      return handlePm2RestartCommand(incoming, args);

    case 'clear':
      return await handleClearCommand(incoming.platformKey, memoryKey);

    case 'resume':
    case 'sessions':
      return await handleResumeCommand(incoming.platformKey, args);

    case 'fork':
      return await handleForkCommand(incoming.platformKey, memoryKey, args);

    case 'merge':
      return await handleMergeCommand(incoming.platformKey, memoryKey, args);

    case 'status':
      return await handleStatusCommand(incoming.platformKey);

    case 'current':
      return await handleCurrentSessionCommand(incoming.platformKey);

    case 'stop':
      return handleStopCommand(incoming.platformKey);

    case 'detach':
      return await handleDetachCommand(incoming.platformKey);

    case 'ping':
      return handlePingCommand();

    case 'skills':
      return handleSkillsCommand(args);

    case 'compact':
      return await handleCompactCommand(incoming.platformKey, memoryKey);

    case 'memory':
      return await handleMemoryCommand(incoming.platformKey, memoryKey, args);

    case 'mode':
      return handleModeCommand(args);

    case 'model':
      return await handleModelCommand(args);

    case 'insight':
      return handleInsightCommand(args);

    case 'soul':
      return await handleSoulCommand(incoming.platformKey, args);

    case 'acp':
      return await handleAcpCommand(incoming.platformKey, args);

    default: {
      // In ACP mode, pass unrecognized slash commands through to the ACP agent as-is
      const acpState = await getAcpState(incoming.platformKey);
      if (acpState) {
        return { type: 'transformed', text: incoming.text };
      }
      return {
        type: 'handled',
        message: `⚠️ 未知命令: /${command}\n\n${buildHelpMessage()}`,
      };
    }
  }
}
