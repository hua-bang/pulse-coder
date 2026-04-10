/**
 * IPC handlers for the Canvas Agent.
 *
 * Channels:
 *   canvas-agent:chat              — send a message, stream text deltas, get final response
 *   canvas-agent:abort             — interrupt the currently-running chat turn
 *   canvas-agent:clarify-answer    — deliver a user reply to a pending clarification
 *   canvas-agent:status            — check if agent is active
 *   canvas-agent:history           — get current session messages
 *   canvas-agent:sessions          — list all sessions (current + archived)
 *   canvas-agent:new-session       — start a new session
 *   canvas-agent:load-session      — load an archived session
 *   canvas-agent:activate          — explicitly start the agent
 *   canvas-agent:deactivate        — stop the agent and archive session
 *
 * Streaming:
 *   canvas-agent:chat returns { ok, sessionId } immediately.
 *   Text deltas arrive on         `canvas-agent:text-delta:{sessionId}`.
 *   Tool call starts arrive on    `canvas-agent:tool-call:{sessionId}`.
 *   Tool results arrive on        `canvas-agent:tool-result:{sessionId}`.
 *   Clarification requests arrive on `canvas-agent:clarify-request:{sessionId}`.
 *   Completion arrives on         `canvas-agent:chat-complete:{sessionId}`.
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { CanvasAgentService } from './canvas-agent/service';

let service: CanvasAgentService | null = null;

/**
 * Track which workspace each in-flight sessionId belongs to, so that
 * clarification answers from the renderer can be routed back to the right
 * agent instance. Entries are cleared when the corresponding chat turn
 * completes or is aborted.
 */
const sessionWorkspaceMap = new Map<string, string>();

function getService(): CanvasAgentService {
  if (!service) {
    service = new CanvasAgentService();
  }
  return service;
}

export function setupCanvasAgentIpc(): void {
  const svc = getService();

  ipcMain.handle(
    'canvas-agent:chat',
    async (
      event,
      payload: { workspaceId: string; message: string; mentionedWorkspaceIds?: string[] },
    ) => {
      const sessionId = randomUUID();
      const sender = event.sender;
      sessionWorkspaceMap.set(sessionId, payload.workspaceId);

      // Fire-and-forget: run the agent asynchronously, streaming text deltas
      void (async () => {
        try {
          const result = await svc.chat(
            payload.workspaceId,
            payload.message,
            (delta) => {
              if (!sender.isDestroyed()) {
                sender.send(`canvas-agent:text-delta:${sessionId}`, delta);
              }
            },
            (toolCall) => {
              if (!sender.isDestroyed()) {
                sender.send(`canvas-agent:tool-call:${sessionId}`, toolCall);
              }
            },
            (toolResult) => {
              if (!sender.isDestroyed()) {
                sender.send(`canvas-agent:tool-result:${sessionId}`, toolResult);
              }
            },
            payload.mentionedWorkspaceIds,
            (req) => {
              if (!sender.isDestroyed()) {
                sender.send(`canvas-agent:clarify-request:${sessionId}`, req);
              }
            },
          );
          if (!sender.isDestroyed()) {
            sender.send(`canvas-agent:chat-complete:${sessionId}`, result);
          }
        } catch (err) {
          if (!sender.isDestroyed()) {
            sender.send(`canvas-agent:chat-complete:${sessionId}`, {
              ok: false,
              error: String(err),
            });
          }
        } finally {
          sessionWorkspaceMap.delete(sessionId);
        }
      })();

      // Return immediately with the sessionId for the renderer to subscribe
      return { ok: true, sessionId };
    },
  );

  ipcMain.handle(
    'canvas-agent:abort',
    (_event, payload: { sessionId?: string; workspaceId?: string }) => {
      const workspaceId =
        payload.workspaceId ??
        (payload.sessionId ? sessionWorkspaceMap.get(payload.sessionId) : undefined);
      if (!workspaceId) return { ok: false, error: 'No active run for sessionId' };
      svc.abort(workspaceId);
      return { ok: true };
    },
  );

  ipcMain.handle(
    'canvas-agent:clarify-answer',
    (
      _event,
      payload: { sessionId: string; requestId: string; answer: string },
    ) => {
      const workspaceId = sessionWorkspaceMap.get(payload.sessionId);
      if (!workspaceId) return { ok: false, error: 'No active run for sessionId' };
      const matched = svc.answerClarification(workspaceId, payload.requestId, payload.answer);
      return { ok: matched, error: matched ? undefined : 'No pending clarification matched' };
    },
  );

  ipcMain.handle(
    'canvas-agent:status',
    (_event, payload: { workspaceId: string }) => {
      return svc.getStatus(payload.workspaceId);
    },
  );

  ipcMain.handle(
    'canvas-agent:history',
    (_event, payload: { workspaceId: string }) => {
      return { ok: true, messages: svc.getHistory(payload.workspaceId) };
    },
  );

  ipcMain.handle(
    'canvas-agent:sessions',
    async (_event, payload: { workspaceId: string }) => {
      try {
        const sessions = await svc.listSessions(payload.workspaceId);
        return { ok: true, sessions };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'canvas-agent:new-session',
    async (_event, payload: { workspaceId: string }) => {
      try {
        return await svc.newSession(payload.workspaceId);
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'canvas-agent:load-session',
    async (_event, payload: { workspaceId: string; sessionId: string }) => {
      try {
        return await svc.loadSession(payload.workspaceId, payload.sessionId);
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'canvas-agent:all-sessions',
    async (_event, payload: { workspaceNames: Record<string, string> }) => {
      try {
        const groups = await svc.listAllSessions(payload.workspaceNames);
        return { ok: true, groups };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'canvas-agent:load-cross-workspace-session',
    async (_event, payload: { targetWorkspaceId: string; sourceWorkspaceId: string; sessionId: string }) => {
      try {
        return await svc.loadCrossWorkspaceSession(
          payload.targetWorkspaceId,
          payload.sourceWorkspaceId,
          payload.sessionId,
        );
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'canvas-agent:activate',
    async (_event, payload: { workspaceId: string }) => {
      try {
        await svc.activate(payload.workspaceId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );

  ipcMain.handle(
    'canvas-agent:deactivate',
    async (_event, payload: { workspaceId: string }) => {
      try {
        await svc.deactivate(payload.workspaceId);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    },
  );
}

export function teardownCanvasAgent(): void {
  if (service) {
    void service.deactivateAll();
    service = null;
  }
}
