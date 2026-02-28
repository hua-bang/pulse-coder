import type { ClarificationRequest } from './types.js';
import type { CompactionEvent } from 'pulse-coder-engine';
import { engine } from './engine-singleton.js';
import { sessionStore } from './session-store.js';
import { memoryIntegration, recordDailyLogFromSuccessPath } from './memory-integration.js';
import { buildRemoteWorktreeRunContext, worktreeIntegration } from './worktree/integration.js';

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

export async function executeAgentTurn(input: ExecuteAgentTurnInput): Promise<ExecuteAgentTurnResult> {
  const session = await sessionStore.getOrCreate(input.platformKey, input.forceNewSession, input.memoryKey);
  const sessionId = session.sessionId;
  const context = session.context;
  const callbacks = input.callbacks ?? {};
  const compactions: CompactionSnapshot[] = [];

  context.messages.push({ role: 'user', content: input.userText });

  const resultText = await runWithAgentContexts(
    {
      platformKey: input.platformKey,
      memoryKey: input.memoryKey,
      sessionId,
      userText: input.userText,
    },
    async () => engine.run(context, {
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
