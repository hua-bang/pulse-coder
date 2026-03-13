import { memoryService } from '../../memory-integration.js';
import { sessionStore } from '../../session-store.js';
import type { CommandResult } from '../types.js';

export async function handleMemoryCommand(platformKey: string, memoryKey: string, args: string[]): Promise<CommandResult> {
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
