import type { ClarificationRequest } from './types.js';
import type { CompactionEvent } from 'pulse-coder-engine';
import { engine } from './engine-singleton.js';
import { sessionStore } from './session-store.js';
import { memoryIntegration, recordDailyLogFromSuccessPath } from './memory-integration.js';
import { buildRemoteWorktreeRunContext, worktreeIntegration } from './worktree/integration.js';
import { resolveModelForRun } from './model-config.js';

export type CompactionSnapshot = CompactionEvent;

export interface AgentTurnCallbacks {
  onText?: (delta: string) => void;
  onToolCall?: (toolCall: any) => void;
  onToolResult?: (toolResult: any) => void;
  onClarificationRequest?: (request: ClarificationRequest) => Promise<string>;
  onCompactionEvent?: (event: CompactionSnapshot) => void;
}

export interface ExecuteAgentTurnInput {
  platformKey: string;
  memoryKey: string;
  forceNewSession?: boolean;
  userText: string;
  source: 'dispatcher' | 'internal';
  abortSignal?: AbortSignal;
  callbacks?: AgentTurnCallbacks;
}

export interface ExecuteAgentTurnResult {
  sessionId: string;
  resultText: string;
  compactions: CompactionSnapshot[];
}

interface RunChannelInfo {
  platform: 'feishu' | 'discord' | 'telegram' | 'web' | 'internal' | 'unknown';
  kind?: 'group' | 'dm' | 'thread' | 'channel' | 'chat' | 'user' | 'internal';
  channelId?: string;
  userId?: string;
  isThread?: boolean;
}

function buildRunContext(input: {
  sessionId: string;
  userText: string;
  platformKey: string;
  ownerKey?: string;
}): Record<string, any> {
  const channel = parseChannelInfo(input.platformKey);
  const callerSelectors = buildCallerSelectors(input.platformKey, channel);

  return {
    sessionId: input.sessionId,
    userText: input.userText,
    platformKey: input.platformKey,
    ownerKey: input.ownerKey,
    caller: callerSelectors[0],
    callerSelectors,
    channel: channel ?? undefined,
  };
}

function parseChannelInfo(platformKey: string): RunChannelInfo | undefined {
  const normalized = platformKey.trim();
  if (!normalized) {
    return undefined;
  }

  const feishuGroup = /^feishu:group:([^:]+):([^:]+)$/.exec(normalized);
  if (feishuGroup) {
    return {
      platform: 'feishu',
      kind: 'group',
      channelId: feishuGroup[1],
      userId: feishuGroup[2],
    };
  }

  const feishuDm = /^feishu:([^:]+)$/.exec(normalized);
  if (feishuDm) {
    return {
      platform: 'feishu',
      kind: 'dm',
      channelId: feishuDm[1],
      userId: feishuDm[1],
    };
  }

  const discordThread = /^discord:thread:([^:]+)$/.exec(normalized);
  if (discordThread) {
    return {
      platform: 'discord',
      kind: 'thread',
      channelId: discordThread[1],
      isThread: true,
    };
  }

  const discordChannel = /^discord:channel:([^:]+):([^:]+)$/.exec(normalized);
  if (discordChannel) {
    return {
      platform: 'discord',
      kind: 'channel',
      channelId: discordChannel[1],
      userId: discordChannel[2],
      isThread: false,
    };
  }

  const discordDm = /^discord:([^:]+)$/.exec(normalized);
  if (discordDm) {
    return {
      platform: 'discord',
      kind: 'dm',
      userId: discordDm[1],
    };
  }

  const telegram = /^telegram:(.+)$/.exec(normalized);
  if (telegram) {
    return {
      platform: 'telegram',
      kind: 'chat',
      channelId: telegram[1],
    };
  }

  const web = /^web:(.+)$/.exec(normalized);
  if (web) {
    return {
      platform: 'web',
      kind: 'user',
      userId: web[1],
    };
  }

  const internal = /^internal:(.+)$/.exec(normalized);
  if (internal) {
    return {
      platform: 'internal',
      kind: 'internal',
      channelId: internal[1],
    };
  }

  return { platform: 'unknown' };
}

function buildCallerSelectors(platformKey: string, channel?: RunChannelInfo): string[] {
  const selectors = new Set<string>();
  const normalizedPlatformKey = platformKey.trim().toLowerCase();

  if (normalizedPlatformKey) {
    selectors.add(`platform_key:${normalizedPlatformKey}`);
  }

  if (channel?.platform) {
    selectors.add(`platform:${channel.platform}`);
  }

  if (channel?.kind) {
    selectors.add(`kind:${channel.kind}`);
  }

  if (channel?.isThread === true) {
    selectors.add('thread:true');
  }

  if (channel?.isThread === false) {
    selectors.add('thread:false');
  }

  return [...selectors];
}

function buildChannelSystemPrompt(platformKey: string): string | null {
  const channel = parseChannelInfo(platformKey);
  if (!channel || (channel.platform !== 'discord' && channel.platform !== 'feishu')) {
    return null;
  }

  const lines = [
    'Channel context:',
    `platform=${channel.platform}`,
    channel.kind ? `kind=${channel.kind}` : '',
    channel.channelId ? `channelId=${channel.channelId}` : '',
  ].filter(Boolean);

  if (lines.length <= 1) {
    return null;
  }

  return lines.join('\n');
}

export async function executeAgentTurn(input: ExecuteAgentTurnInput): Promise<ExecuteAgentTurnResult> {
  const session = await sessionStore.getOrCreate(input.platformKey, input.forceNewSession, input.memoryKey);
  const sessionId = session.sessionId;
  const context = session.context;
  const callbacks = input.callbacks ?? {};
  const compactions: CompactionSnapshot[] = [];
  const modelOverride = await resolveModelForRun(input.platformKey);

  context.messages.push({ role: 'user', content: input.userText });

  const runContext = buildRunContext({
    sessionId,
    userText: input.userText,
    platformKey: input.platformKey,
    ownerKey: input.memoryKey,
  });

  const resultText = await runWithAgentContexts(
    {
      platformKey: input.platformKey,
      memoryKey: input.memoryKey,
      sessionId,
      userText: input.userText,
      source: input.source,
    },
    async () => engine.run(context, {
      model: modelOverride,
      runContext,
      systemPrompt: (() => {
        const channelPrompt = buildChannelSystemPrompt(input.platformKey);
        return channelPrompt ? { append: `\n${channelPrompt}` } : undefined;
      })(),
      abortSignal: input.abortSignal,
      onText: callbacks.onText,
      onToolCall: callbacks.onToolCall,
      onToolResult: callbacks.onToolResult,
      onResponse: (messages) => {
        for (const msg of messages) {
          context.messages.push(msg);
        }
      },
      onCompacted: (newMessages, event) => {
        if (event) {
          compactions.push(event);
          callbacks.onCompactionEvent?.(event);
        }
        context.messages = newMessages;
      },
      onClarificationRequest: callbacks.onClarificationRequest,
    }),
  );

  await sessionStore.save(sessionId, context);
  await recordDailyLogFromSuccessPath({
    platformKey: input.memoryKey,
    sessionId,
    userText: input.userText,
    assistantText: resultText,
    source: input.source,
  });

  return {
    sessionId,
    resultText,
    compactions,
  };
}

export async function runWithAgentContexts<T>(
  input: {
    platformKey: string;
    memoryKey: string;
    sessionId: string;
    userText: string;
    source: string;
  },
  run: () => Promise<T>,
): Promise<T> {
  return worktreeIntegration.withRunContext(
    buildRemoteWorktreeRunContext(input.platformKey),
    async () => memoryIntegration.withRunContext(
      {
        platformKey: input.memoryKey,
        sessionId: input.sessionId,
        userText: input.userText,
      },
      run,
    ),
  );
}

export function formatCompactionEvents(events: CompactionSnapshot[]): string {
  return events
    .map((event) => {
      const reason = event.reason ?? event.strategy;
      return `#${event.attempt} ${event.trigger} ${reason} msgs:${event.beforeMessageCount}->${event.afterMessageCount} tokens:${event.beforeEstimatedTokens}->${event.afterEstimatedTokens}`;
    })
    .join(' | ');
}
