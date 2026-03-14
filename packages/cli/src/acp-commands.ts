import { promises as fs } from 'fs';
import { resolve as resolvePath } from 'path';
import { clearAcpState, getAcpState, setAcpState, updateAcpCwd } from 'pulse-coder-acp';
import type { AcpAgent } from 'pulse-coder-acp';

const DEFAULT_ACP_USER = 'local';
const VALID_AGENTS: AcpAgent[] = ['claude', 'codex'];

export const ACP_CLIENT_INFO = {
  name: 'pulse-cli',
  title: 'Pulse CLI',
  version: '1.0.0',
};

export function resolveAcpPlatformKey(): string {
  const explicit = process.env.PULSE_CODER_ACP_PLATFORM_KEY?.trim();
  if (explicit) {
    return explicit;
  }

  const memoryKey = process.env.PULSE_CODER_MEMORY_PLATFORM_KEY?.trim();
  if (memoryKey) {
    return memoryKey;
  }

  const user = process.env.PULSE_CODER_ACP_USER?.trim()
    || process.env.USER?.trim()
    || process.env.LOGNAME?.trim()
    || DEFAULT_ACP_USER;
  return `cli:${user}`;
}

export async function handleAcpCommand(platformKey: string, args: string[]): Promise<string> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === 'status') {
    const state = await getAcpState(platformKey);
    if (!state) {
      return 'ℹ️ ACP 未启用。\n使用 `/acp on <claude|codex> [cwd]` 开启。';
    }
    const lines = [
      '🤖 ACP 已启用',
      `- agent: ${state.agent}`,
      `- cwd: ${state.cwd}`,
      state.sessionId ? `- session: ${state.sessionId}` : '- session: (新会话)',
    ];
    return lines.join('\n');
  }

  if (sub === 'on') {
    const agentRaw = args[1]?.toLowerCase();
    if (!agentRaw || !isValidAgent(agentRaw)) {
      return '❌ 用法：`/acp on <claude|codex> [cwd]`';
    }

    let cwd = args[2]?.trim();
    if (cwd) {
      cwd = resolvePath(cwd);
      if (!(await dirExists(cwd))) {
        return `❌ 目录不存在：${cwd}`;
      }
    } else {
      const existing = await getAcpState(platformKey);
      cwd = existing?.cwd ?? process.cwd();
    }

    await setAcpState(platformKey, { agent: agentRaw, cwd });
    return `✅ ACP 已开启\n- agent: ${agentRaw}\n- cwd: ${cwd}\n下次发消息将由 ${agentRaw} 处理。`;
  }

  if (sub === 'off') {
    const existing = await getAcpState(platformKey);
    if (!existing) {
      return 'ℹ️ ACP 本来就是关闭状态。';
    }
    await clearAcpState(platformKey);
    return '✅ ACP 已关闭，恢复使用 pulse-agent。';
  }

  if (sub === 'cd') {
    const rawPath = args[1]?.trim();
    if (!rawPath) {
      return '❌ 用法：`/acp cd <path>`';
    }

    const newCwd = resolvePath(rawPath);
    if (!(await dirExists(newCwd))) {
      return `❌ 目录不存在：${newCwd}`;
    }

    const updated = await updateAcpCwd(platformKey, newCwd);
    if (!updated) {
      return '❌ ACP 未启用，请先 `/acp on <claude|codex>`。';
    }

    return `✅ ACP 工作目录已切换\n- cwd: ${newCwd}\n旧 session 已重置，下次发消息将开启新会话。`;
  }

  return [
    '⚠️ 未知子命令。ACP 用法：',
    '`/acp on <claude|codex> [cwd]` — 开启 ACP 模式',
    '`/acp off`                     — 关闭，恢复 pulse-agent',
    '`/acp cd <path>`               — 切换工作目录（重置 session）',
    '`/acp status`                  — 查看当前状态',
  ].join('\n');
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const stat = await fs.stat(p);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

function isValidAgent(value: string): value is AcpAgent {
  return (VALID_AGENTS as string[]).includes(value);
}
