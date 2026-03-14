/**
 * ACP Runner — drives a full ACP session/prompt turn and maps
 * streaming session/update notifications to the same callbacks
 * that engine.run() uses, so agent-runner.ts can swap them transparently.
 */
import { AcpClient, type SessionUpdateNotification, type InitializeResult, type SessionNewResult, type PromptResult } from './client.js';
import { saveAcpSessionId } from './state.js';
import type { AcpAgent } from './state.js';

export interface AcpRunnerCallbacks {
  onText?: (delta: string) => void;
  onToolCall?: (toolCall: unknown) => void;
  onToolResult?: (toolResult: unknown) => void;
}

export interface AcpRunnerInput {
  platformKey: string;
  agent: AcpAgent;
  cwd: string;
  sessionId?: string;
  userText: string;
  abortSignal?: AbortSignal;
  callbacks?: AcpRunnerCallbacks;
}

export interface AcpRunnerResult {
  text: string;
  sessionId: string;
  stopReason: string;
}

export async function runAcp(input: AcpRunnerInput): Promise<AcpRunnerResult> {
  const client = new AcpClient(input.agent, input.cwd);

  try {
    // 1. Handshake — declare fs capabilities so agents can read/write files via us
    const initResult = await client.call<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: { name: 'pulse-remote-server', title: 'Pulse Remote Server', version: '1.0.0' },
    });

    // 2. Session — resume if we have a saved sessionId and the agent supports it
    let sessionId = input.sessionId;
    const supportsLoad = initResult.agentCapabilities?.loadSession === true;

    if (sessionId && supportsLoad) {
      try {
        // session/load replays history via session/update notifications (we ignore them)
        await client.call('session/load', {
          sessionId,
          cwd: input.cwd,
          mcpServers: [],
        });
      } catch (err) {
        console.warn('[acp/runner] session/load failed, starting fresh:', err);
        sessionId = undefined;
      }
    }

    if (!sessionId) {
      const newSession = await client.call<SessionNewResult>('session/new', {
        cwd: input.cwd,
        mcpServers: [],
      });
      sessionId = newSession.sessionId;
    }

    // 3. Subscribe to session/update notifications
    const textChunks: string[] = [];
    const unsub = client.onNotification((method, params) => {
      if (method !== 'session/update') return;

      // Log raw notification to help diagnose field mapping issues
      if (process.env.ACP_DEBUG === '1' || process.env.ACP_DEBUG === 'true') {
        console.error('[acp/runner] session/update raw:', JSON.stringify(params));
      }

      const notif = params as SessionUpdateNotification;
      const { update } = notif;
      if (!update) return;

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const delta = update.content?.text ?? '';
          if (delta) {
            textChunks.push(delta);
            input.callbacks?.onText?.(delta);
          }
          break;
        }
        case 'tool_call':
        case 'tool_call_update': {
          if (update.status === 'in_progress' || update.status === 'pending') {
            input.callbacks?.onToolCall?.({
              toolCallId: update.toolCallId,
              title: update.title,
              kind: update.kind,
              status: update.status,
            });
          } else if (update.status === 'completed') {
            input.callbacks?.onToolResult?.({
              toolCallId: update.toolCallId,
              entries: update.entries,
              status: update.status,
            });
          }
          break;
        }
        case 'plan':
          // plan updates are informational — no callback needed for now
          break;
      }
    });

    // 4. Abort wiring
    const abortHandler = () => {
      client.call('session/cancel', { sessionId }).catch(() => {});
    };
    input.abortSignal?.addEventListener('abort', abortHandler);

    // 5. Prompt turn
    let promptResult: PromptResult;
    try {
      promptResult = await client.call<PromptResult>('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text: input.userText }],
      });
    } finally {
      input.abortSignal?.removeEventListener('abort', abortHandler);
      unsub();
    }

    // 6. Persist new sessionId for next turn resume
    await saveAcpSessionId(input.platformKey, sessionId);

    return {
      text: textChunks.join(''),
      sessionId,
      stopReason: promptResult.stopReason,
    };
  } finally {
    client.kill();
  }
}
