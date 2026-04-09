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
import { CanvasAgent } from './canvas-agent';
import type {
  ChatResponse,
  AgentStatusResponse,
  SessionListResponse,
  CanvasAgentMessage,
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
   */
  async chat(
    workspaceId: string,
    message: string,
    onText?: (delta: string) => void,
    onToolCall?: (data: { name: string; args: any }) => void,
    onToolResult?: (data: { name: string; result: string }) => void,
  ): Promise<ChatResponse> {
    try {
      await this.activate(workspaceId);
      const agent = this.agents.get(workspaceId)!;
      const response = await agent.chat(message, onText, onToolCall, onToolResult);
      return { ok: true, response };
    } catch (err) {
      console.error(`[canvas-agent-service] chat error for ${workspaceId}:`, err);
      return { ok: false, error: String(err) };
    }
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
