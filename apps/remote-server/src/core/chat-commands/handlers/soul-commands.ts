import { sessionStore } from '../../session-store.js';
import type { CommandResult } from '../types.js';
import { getSoulService } from '../services.js';
import { buildSoulListMessage } from '../soul-utils.js';

export async function handleSoulCommand(platformKey: string, args: string[]): Promise<CommandResult> {
  const service = getSoulService();
  if (!service) {
    return {
      type: 'handled',
      message: '⚠️ 当前引擎未启用 soul 服务。',
    };
  }

  const sub = args[0]?.toLowerCase() ?? 'list';
  const sessionId = sessionStore.getCurrentSessionId(platformKey);

  if (!sessionId) {
    return {
      type: 'handled',
      message: 'ℹ️ 当前没有会话，先发送一条普通消息创建会话后再使用 soul 命令。',
    };
  }

  if (sub === 'list' || sub === 'ls') {
    const state = await service.getState(sessionId);
    return {
      type: 'handled',
      message: buildSoulListMessage(service.listSouls(), state),
    };
  }

  if (sub === 'status') {
    const state = await service.getState(sessionId);
    return {
      type: 'handled',
      message: state?.activeSoulIds?.length
        ? `🎭 当前 soul：${state.activeSoulIds.join(', ')}`
        : '🎭 当前未启用 soul。',
    };
  }

  if (sub === 'clear') {
    await service.clearSession(sessionId);
    return {
      type: 'handled',
      message: `🧹 已清除当前会话 soul\nSession ID: ${sessionId}`,
    };
  }

  const soulId = args[1];
  if (!soulId) {
    return {
      type: 'handled',
      message: '❌ 缺少 soul id\n用法：/soul use|add|remove <id>',
    };
  }

  if (sub === 'use') {
    const result = await service.useSoul(sessionId, soulId);
    if (!result.ok) {
      return {
        type: 'handled',
        message: `❌ soul 设置失败：${result.reason ?? 'unknown error'}`,
      };
    }

    return {
      type: 'handled',
      message: `✅ 已启用 soul：${soulId}`,
    };
  }

  if (sub === 'add') {
    const result = await service.addSoul(sessionId, soulId);
    if (!result.ok) {
      return {
        type: 'handled',
        message: `❌ soul 追加失败：${result.reason ?? 'unknown error'}`,
      };
    }

    return {
      type: 'handled',
      message: `✅ 已追加 soul：${soulId}`,
    };
  }

  if (sub === 'remove' || sub === 'rm') {
    const result = await service.removeSoul(sessionId, soulId);
    if (!result.ok) {
      return {
        type: 'handled',
        message: `❌ soul 移除失败：${result.reason ?? 'unknown error'}`,
      };
    }

    return {
      type: 'handled',
      message: `✅ 已移除 soul：${soulId}`,
    };
  }

  return {
    type: 'handled',
    message: '❌ 用法：/soul list | /soul status | /soul use <id> | /soul add <id> | /soul remove <id> | /soul clear',
  };
}
