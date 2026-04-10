/**
 * CanvasAgentService — manages one Canvas Agent per workspace.
 *
 * Lifecycle:
 *   activate(workspaceId)  → creates + initializes agent
 *   chat(workspaceId, msg) → runs a turn
 *   deactivate(workspaceId) → archives session + destroys agent
 */

import { join } from 'path';
import { homedir } from 'os';
import { CanvasAgent, type CanvasClarificationRequest } from './canvas-agent';
import { SessionStore } from './session-store';
import type {
  ChatResponse,
  AgentStatusResponse,
  SessionListResponse,
  CanvasAgentMessage,
  CrossWorkspaceSessionGroup,
} from './types';

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

export class CanvasAgentService {
  private agents = new Map<string, CanvasAgent>();

  /**
   * Activate the Canvas Agent for a workspace. Idempotent — if already
   * active, returns immediately.
   */
  async activate(workspaceId: string): Promise<void> {
    if (this.agents.has(workspaceId)) return;

    const agent = new CanvasAgent({
      workspaceId,
      workspaceDir: join(STORE_DIR, workspaceId),
    });

    await agent.initialize();
    this.agents.set(workspaceId, agent);
  }

  /**
   * Send a chat message to the workspace's Canvas Agent.
   * Auto-activates the agent if not already active.
   * @param onText — optional callback receiving streaming text deltas
   * @param onClarificationRequest — invoked when the agent needs to ask the
   *   user a clarifying question; the caller must eventually deliver the
   *   reply via `answerClarification` or cancel via `abort`.
   */
  async chat(
    workspaceId: string,
    message: string,
    onText?: (delta: string) => void,
    onToolCall?: (data: { name: string; args: any }) => void,
    onToolResult?: (data: { name: string; result: string }) => void,
    mentionedWorkspaceIds?: string[],
    onClarificationRequest?: (req: CanvasClarificationRequest) => void,
  ): Promise<ChatResponse> {
    try {
      await this.activate(workspaceId);
      const agent = this.agents.get(workspaceId)!;
      const response = await agent.chat(
        message,
        onText,
        onToolCall,
        onToolResult,
        mentionedWorkspaceIds,
        onClarificationRequest,
      );
      return { ok: true, response };
    } catch (err) {
      console.error(`[canvas-agent-service] chat error for ${workspaceId}:`, err);
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Abort the workspace's currently-running chat turn (if any). No-op when
   * the agent is idle or not activated.
   */
  abort(workspaceId: string): void {
    this.agents.get(workspaceId)?.abort();
  }

  /**
   * Deliver the user's answer to a pending clarification request.
   * Returns true if a matching pending request was resolved.
   */
  answerClarification(workspaceId: string, requestId: string, answer: string): boolean {
    const agent = this.agents.get(workspaceId);
    if (!agent) return false;
    return agent.answerClarification(requestId, answer);
  }

  /**
   * Get the agent's status for a workspace.
   */
  getStatus(workspaceId: string): AgentStatusResponse {
    const agent = this.agents.get(workspaceId);
    if (!agent) return { ok: true, active: false, messageCount: 0 };
    return { ok: true, active: true, messageCount: agent.getMessageCount() };
  }

  /**
   * Get conversation history for the current session.
   */
  getHistory(workspaceId: string): CanvasAgentMessage[] {
    const agent = this.agents.get(workspaceId);
    return agent?.getHistory() ?? [];
  }

  /**
   * List all sessions (current + archived) for a workspace.
   */
  async listSessions(workspaceId: string): Promise<Array<{ sessionId: string; date: string; messageCount: number; isCurrent: boolean }>> {
    await this.activate(workspaceId);
    const agent = this.agents.get(workspaceId)!;
    return agent.listSessions();
  }

  /**
   * Start a new session for a workspace.
   */
  async newSession(workspaceId: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this.activate(workspaceId);
      const agent = this.agents.get(workspaceId)!;
      await agent.newSession();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Load a specific session by sessionId.
   */
  async loadSession(workspaceId: string, sessionId: string): Promise<{ ok: boolean; messages?: CanvasAgentMessage[]; error?: string }> {
    try {
      await this.activate(workspaceId);
      const agent = this.agents.get(workspaceId)!;
      const messages = await agent.loadSession(sessionId);
      return { ok: true, messages };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * List sessions from ALL workspaces, grouped by workspace.
   * @param workspaceNames — map of workspaceId → display name (from renderer manifest)
   */
  async listAllSessions(
    workspaceNames: Record<string, string>,
  ): Promise<CrossWorkspaceSessionGroup[]> {
    const diskGroups = await SessionStore.listAllWorkspaceSessions();
    const groups: CrossWorkspaceSessionGroup[] = [];

    for (const g of diskGroups) {
      // If this workspace has an active in-memory agent, use its live session list
      const agent = this.agents.get(g.workspaceId);
      const sessions = agent
        ? await agent.listSessions()
        : g.sessions;

      groups.push({
        workspaceId: g.workspaceId,
        workspaceName: workspaceNames[g.workspaceId] || g.workspaceId,
        sessions,
      });
    }

    // Sort: ensure workspaces with more recent sessions come first
    groups.sort((a, b) => {
      const aDate = a.sessions[0]?.date ?? '';
      const bDate = b.sessions[0]?.date ?? '';
      return bDate.localeCompare(aDate);
    });

    return groups;
  }

  /**
   * Load a session from a different workspace into the current workspace's agent.
   */
  async loadCrossWorkspaceSession(
    targetWorkspaceId: string,
    sourceWorkspaceId: string,
    sessionId: string,
  ): Promise<{ ok: boolean; messages?: CanvasAgentMessage[]; error?: string }> {
    try {
      // Read session data from source workspace
      const session = await SessionStore.readSessionFromWorkspace(sourceWorkspaceId, sessionId);
      if (!session) return { ok: false, error: 'Session not found in source workspace' };

      // Activate target workspace agent
      await this.activate(targetWorkspaceId);
      const agent = this.agents.get(targetWorkspaceId)!;

      // Archive current session, then set loaded messages as current view
      await agent.loadCrossWorkspaceSession(session.messages);

      return { ok: true, messages: session.messages };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  }

  /**
   * Deactivate and archive the Canvas Agent for a workspace.
   */
  async deactivate(workspaceId: string): Promise<void> {
    const agent = this.agents.get(workspaceId);
    if (!agent) return;
    await agent.destroy();
    this.agents.delete(workspaceId);
  }

  /**
   * Deactivate all agents (called on app shutdown).
   */
  async deactivateAll(): Promise<void> {
    const ids = Array.from(this.agents.keys());
    await Promise.all(ids.map(id => this.deactivate(id)));
  }
}
