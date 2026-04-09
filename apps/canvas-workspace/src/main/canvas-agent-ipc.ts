/**
 * IPC handlers for the Canvas Agent.
 *
 * Channels:
 *   canvas-agent:chat         — send a message, stream text deltas, get final response
 *   canvas-agent:status       — check if agent is active
 *   canvas-agent:history      — get current session messages
 *   canvas-agent:sessions     — list all sessions (current + archived)
 *   canvas-agent:new-session  — start a new session
 *   canvas-agent:load-session — load an archived session
 *   canvas-agent:activate     — explicitly start the agent
 *   canvas-agent:deactivate   — stop the agent and archive session
 *
 * Streaming:
 *   canvas-agent:chat returns { ok, sessionId } immediately.
 *   Text deltas arrive on    `canvas-agent:text-delta:{sessionId}`.
 *   Tool call starts arrive on `canvas-agent:tool-call:{sessionId}`.
 *   Tool results arrive on    `canvas-agent:tool-result:{sessionId}`.
 *   Completion arrives on     `canvas-agent:chat-complete:{sessionId}`.
 */

import { ipcMain } from 'electron';
import { randomUUID } from 'crypto';
import { CanvasAgentService } from './canvas-agent/service';

let service: CanvasAgentService | null = null;

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
    async (event, payload: { workspaceId: string; message: string }) => {
      const sessionId = randomUUID();
      const sender = event.sender;

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
        }
      })();

      // Return immediately with the sessionId for the renderer to subscribe
      return { ok: true, sessionId };
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
