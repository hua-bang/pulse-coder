import { promises as fs } from 'fs';
import { resolve as resolvePath } from 'path';
import { getAcpState, setAcpState, clearAcpState, updateAcpCwd } from 'pulse-coder-acp';
import type { AcpAgent } from 'pulse-coder-acp';
import type { CommandResult } from '../types.js';

const VALID_AGENTS: AcpAgent[] = ['claude', 'codex'];

function isValidAgent(s: string): s is AcpAgent {
  return (VALID_AGENTS as string[]).includes(s);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

export async function handleAcpCommand(platformKey: string, args: string[]): Promise<CommandResult> {
  const sub = args[0]?.toLowerCase();

  // /acp  or  /acp status
  if (!sub || sub === 'status') {
    const state = await getAcpState(platformKey);
    if (!state) {
      return {
        type: 'handled',
        message: 'ℹ️ ACP 未启用。\n使用 `/acp on <claude|codex> [cwd]` 开启。',
      };
    }
    const lines = [
      '🤖 ACP 已启用',
      `- agent: ${state.agent}`,
      `- cwd: ${state.cwd}`,
      state.sessionId ? `- session: ${state.sessionId}` : '- session: (新会话)',
    ];
    return { type: 'handled', message: lines.join('\n') };
  }

  // /acp on <claude|codex> [cwd]
  if (sub === 'on') {
    const agentRaw = args[1]?.toLowerCase();
    if (!agentRaw || !isValidAgent(agentRaw)) {
      return {
        type: 'handled',
        message: '❌ 用法：`/acp on <claude|codex> [cwd]`',
      };
    }

    let cwd = args[2]?.trim();
    if (cwd) {
      cwd = resolvePath(cwd);
      if (!(await dirExists(cwd))) {
        return {
          type: 'handled',
          message: `❌ 目录不存在：${cwd}`,
        };
      }
    } else {
      // reuse existing cwd if already configured, else use process.cwd()
      const existing = await getAcpState(platformKey);
      cwd = existing?.cwd ?? process.cwd();
    }

    await setAcpState(platformKey, { agent: agentRaw, cwd });
    return {
      type: 'handled',
      message: `✅ ACP 已开启\n- agent: ${agentRaw}\n- cwd: ${cwd}\n下次发消息将由 ${agentRaw} 处理。`,
    };
  }

  // /acp off
  if (sub === 'off') {
    const existing = await getAcpState(platformKey);
    if (!existing) {
      return { type: 'handled', message: 'ℹ️ ACP 本来就是关闭状态。' };
    }
    await clearAcpState(platformKey);
    return { type: 'handled', message: '✅ ACP 已关闭，恢复使用 pulse-agent。' };
  }

  // /acp cd <path>
  if (sub === 'cd') {
    const rawPath = args[1]?.trim();
    if (!rawPath) {
      return { type: 'handled', message: '❌ 用法：`/acp cd <path>`' };
    }

    const newCwd = resolvePath(rawPath);
    if (!(await dirExists(newCwd))) {
      return { type: 'handled', message: `❌ 目录不存在：${newCwd}` };
    }

    const updated = await updateAcpCwd(platformKey, newCwd);
    if (!updated) {
      return { type: 'handled', message: '❌ ACP 未启用，请先 `/acp on <claude|codex>`。' };
    }

    return {
      type: 'handled',
      message: `✅ ACP 工作目录已切换\n- cwd: ${newCwd}\n旧 session 已重置，下次发消息将开启新会话。`,
    };
  }

  return {
    type: 'handled',
    message: [
      '⚠️ 未知子命令。ACP 用法：',
      '`/acp on <claude|codex> [cwd]` — 开启 ACP 模式',
      '`/acp off`                     — 关闭，恢复 pulse-agent',
      '`/acp cd <path>`               — 切换工作目录（重置 session）',
      '`/acp status`                  — 查看当前状态',
    ].join('\n'),
  };
}
