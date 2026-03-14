import type { CommandResult } from '../types.js';
import { getAcpService } from '../services.js';
import { sessionStore } from '../../session-store.js';

const ACP_TARGET_PATTERN = /(?:^|\s)(?:--?target|target)\s*[:=]\s*([^\s]+)/i;
const ACP_FORCE_NEW_PATTERN = /(?:^|\s)(?:--new|--fresh|new=true|fresh=true|new=1|fresh=1)\b/i;

const ACP_FLAG_TOKENS = /(?:^|\s)--(target|new|fresh)(?=\s|$)/gi;
const ACP_NEW_FLAG_PATTERN = /(?:^|\s)--(new|fresh)(?=\s|$)/i;

interface ParsedAcpInput {
  prompt: string;
  target?: string;
  forceNewSession?: boolean;
  mode?: 'on' | 'off' | 'status';
}

function parseAcpInput(args: string[]): ParsedAcpInput {
  const raw = args.join(' ').trim();
  if (!raw) {
    return { prompt: '' };
  }

  const sub = args[0]?.toLowerCase();
  if (sub === 'on' || sub === 'off' || sub === 'status') {
    return {
      prompt: '',
      mode: sub,
    };
  }

  const targetMatch = raw.match(ACP_TARGET_PATTERN);
  const target = targetMatch?.[1];
  const forceNewSession = ACP_FORCE_NEW_PATTERN.test(raw) || ACP_NEW_FLAG_PATTERN.test(raw);

  const cleaned = raw
    .replace(ACP_TARGET_PATTERN, ' ')
    .replace(ACP_FORCE_NEW_PATTERN, ' ')
    .replace(ACP_FLAG_TOKENS, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    prompt: cleaned,
    target: target?.trim() || undefined,
    forceNewSession: forceNewSession || undefined,
  };
}

export async function handleAcpCommand(platformKey: string, args: string[]): Promise<CommandResult> {
  const service = getAcpService();
  if (!service) {
    return {
      type: 'handled',
      message: 'ACP is not enabled. Confirm the ACP plugin is registered.',
    };
  }

  const parsed = parseAcpInput(args);
  if (parsed.mode) {
    const sessionId = sessionStore.getCurrentSessionId(platformKey);
    if (!sessionId) {
      return {
        type: 'handled',
        message: 'ℹ️ 当前没有会话，先发送一条普通消息创建会话后再设置 ACP 模式。',
      };
    }

    if (parsed.mode === 'status') {
      const enabled = await sessionStore.isAcpModeEnabled(sessionId);
      return {
        type: 'handled',
        message: `🤖 ACP 模式：${enabled ? 'on' : 'off'}\nSession ID: ${sessionId}`,
      };
    }

    const enabled = parsed.mode === 'on';
    await sessionStore.setAcpMode(sessionId, enabled);
    return {
      type: 'handled',
      message: enabled
        ? `✅ 已开启 ACP 模式\nSession ID: ${sessionId}`
        : `🛑 已关闭 ACP 模式\nSession ID: ${sessionId}`,
    };
  }

  if (!parsed.prompt) {
    return {
      type: 'handled',
      message: [
        'Missing prompt.',
        'Usage: /acp <prompt> [target=codex] [--new]',
        'Modes: /acp on | /acp off | /acp status',
      ].join('\n'),
    };
  }

  const status = service.getStatus();
  if (!status.configured) {
    return {
      type: 'handled',
      message: 'ACP bridge is not configured. Set ACP_* env vars first.',
    };
  }

  const directives = [
    'Use acp_prompt with',
    `prompt=${parsed.prompt}`,
  ];

  if (parsed.target) {
    directives.push(`target=${parsed.target}`);
  }

  if (parsed.forceNewSession) {
    directives.push('forceNewSession=true');
  }

  return {
    type: 'transformed',
    text: directives.join(' '),
  };
}
