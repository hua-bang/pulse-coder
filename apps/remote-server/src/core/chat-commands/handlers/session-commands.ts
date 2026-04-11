import { abortActiveRun, getActiveRun } from '../../active-run-store.js';
import { engine } from '../../engine-singleton.js';
import { memoryIntegration, recordCompactSummaryDailyLog } from '../../memory-integration.js';
import { sessionStore } from '../../session-store.js';
import type { CommandResult } from '../types.js';
import {
  estimateMessageTokens,
  formatDuration,
  formatTime,
  getCompactTargetTokens,
  getCompactTriggerTokens,
  getKeepLastTurns,
  parseListLimit,
} from '../utils.js';
import { getSoulService } from '../services.js';
export async function handleNewCommand(platformKey: string, memoryKey: string): Promise<CommandResult> {
  const sessionId = await sessionStore.createNewSession(platformKey, memoryKey);
  return {
    type: 'handled',
    message: `✅ 已创建新会话\nSession ID: ${sessionId}`,
  };
}

export async function handleClearCommand(platformKey: string, memoryKey: string): Promise<CommandResult> {
  const result = await sessionStore.clearCurrent(platformKey, memoryKey);
  if (result.createdNew) {
    return {
      type: 'handled',
      message: `🧹 当前无可清空会话，已新建会话\nSession ID: ${result.sessionId}`,
    };
  }

  const soulService = getSoulService();
  if (soulService) {
    await soulService.clearSession(result.sessionId);
  }

  return {
    type: 'handled',
    message: `🧹 已清空当前会话上下文\nSession ID: ${result.sessionId}`,
  };
}

export async function handleResumeCommand(platformKey: string, args: string[]): Promise<CommandResult> {
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

  const soulService = getSoulService();
  const soulState = soulService ? await soulService.getState(sessionId) : undefined;

  return {
    type: 'handled',
    message: soulState?.activeSoulIds?.length
      ? `✅ 已恢复会话：${sessionId}\n🎭 已加载 soul：${soulState.activeSoulIds.join(', ')}`
      : `✅ 已恢复会话：${sessionId}`,
  };
}

export async function handleForkCommand(platformKey: string, memoryKey: string, args: string[]): Promise<CommandResult> {
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

  const soulService = getSoulService();
  if (soulService) {
    await soulService.cloneState(sourceSessionId, result.sessionId);
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


export async function handleMergeCommand(platformKey: string, memoryKey: string, args: string[]): Promise<CommandResult> {
  const firstArg = args[0]?.toLowerCase();
  const listRequested = args.length === 0 || firstArg === 'list' || firstArg === 'ls';

  if (listRequested) {
    const currentSessionId = sessionStore.getCurrentSessionId(platformKey);
    if (!currentSessionId) {
      return {
        type: 'handled',
        message: 'ℹ️ 当前没有已绑定会话。先发送一条普通消息，再执行 `/merge <session-id>`。',
      };
    }

    const merged = await sessionStore.listMergedSessionSummaries(platformKey, memoryKey);
    if (merged.sessions.length === 0) {
      return {
        type: 'handled',
        message: [
          'ℹ️ 当前会话尚未引用其他会话。',
          `- Current Session ID: ${currentSessionId}`,
          '用法：/merge <session-id>',
        ].join('\n'),
      };
    }

    const lines = merged.sessions.map((session, index) => {
      const preview = session.preview.length > 80 ? `${session.preview.slice(0, 80)}...` : session.preview;
      return `${index + 1}. ${session.id} | ${session.messageCount} 条消息 | ${formatTime(session.updatedAt)}\n   ${preview}`;
    });

    return {
      type: 'handled',
      message: [
        `🧩 当前会话已引用 ${merged.sessions.length} 个会话：`,
        `- Current Session ID: ${merged.currentSessionId ?? currentSessionId}`,
        lines.join('\n'),
        '用法：/merge <session-id>',
      ].join('\n'),
    };
  }

  const targetSessionId = args[0]?.trim();
  if (!targetSessionId) {
    return {
      type: 'handled',
      message: '❌ 缺少 session-id\n用法：/merge <session-id>',
    };
  }

  const result = await sessionStore.mergeSessionReference(platformKey, targetSessionId, memoryKey);
  if (!result.ok) {
    return {
      type: 'handled',
      message: `❌ 无法合并会话：${result.reason ?? '未知错误'}\n用法：/merge <session-id>`,
    };
  }

  if (result.alreadyMerged) {
    return {
      type: 'handled',
      message: [
        'ℹ️ 该会话已在当前引用列表中。',
        `- Current Session ID: ${result.currentSessionId}`,
        `- Merged Session ID: ${result.mergedSessionId ?? targetSessionId}`,
        `- 引用会话数：${result.mergedCount ?? 0}`,
      ].join('\n'),
    };
  }

  return {
    type: 'handled',
    message: [
      '✅ 已引用会话上下文',
      `- Current Session ID: ${result.currentSessionId}`,
      `- Merged Session ID: ${result.mergedSessionId ?? targetSessionId}`,
      `- 引用会话数：${result.mergedCount ?? 0}`,
      '提示：后续对话会自动带上被引用会话上下文。',
    ].join('\n'),
  };
}

export async function handleStatusCommand(platformKey: string): Promise<CommandResult> {
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

    const soulService = getSoulService();
    const soulState = soulService ? await soulService.getState(sessionStatus.sessionId) : undefined;
    if (soulState?.activeSoulIds?.length) {
      lines.push(`- 当前 soul：${soulState.activeSoulIds.join(', ')}`);
    } else {
      lines.push('- 当前 soul：无');
    }
  } else {
    lines.push('- 当前会话：无（发送普通消息会自动创建）');
  }

  return {
    type: 'handled',
    message: lines.join('\n'),
  };
}

export async function handleCurrentSessionCommand(platformKey: string): Promise<CommandResult> {
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

export function handleStopCommand(platformKey: string): CommandResult {
  const result = abortActiveRun(platformKey);
  if (!result.aborted) {
    return {
      type: 'handled',
      message: 'ℹ️ 当前没有正在运行的任务。',
    };
  }

  return {
    type: 'handled_silent',
  };
}

export async function handleDetachCommand(platformKey: string): Promise<CommandResult> {
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

export async function handleCompactCommand(platformKey: string, memoryKey: string): Promise<CommandResult> {
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

    const summary = compactResult.newMessages[0]?.role === 'assistant'
      ? String(compactResult.newMessages[0]?.content ?? '').trim()
      : '';

    if (summary.startsWith('[COMPACTED_CONTEXT]')) {
      await memoryIntegration.withRunContext(
        {
          platformKey: memoryKey,
          sessionId: current.sessionId,
          userText: summary,
        },
        () => recordCompactSummaryDailyLog({
          platformKey: memoryKey,
          sessionId: current.sessionId,
          summary,
          source: 'internal',
        }),
      );
    }

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

export function handlePingCommand(): CommandResult {
  return {
    type: 'handled',
    message: '🏓 pong',
  };
}
