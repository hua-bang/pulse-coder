/**
 * Canvas Agent type definitions.
 *
 * The Canvas Agent is a workspace-scoped AI Copilot that runs in the
 * Electron main process. It understands the entire canvas context and
 * can perform canvas operations, file I/O, and coding tasks directly.
 */

// ─── Configuration ──────────────────────────────────────────────────

export interface CanvasAgentConfig {
  workspaceId: string;
  workspaceDir: string;
  /** Optional model override (e.g. 'gpt-4o', 'claude-sonnet-4-20250514'). */
  model?: string;
}

// ─── Messages ───────────────────────────────────────────────────────

export interface CanvasAgentMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// ─── Session persistence ────────────────────────────────────────────

export interface CanvasAgentSession {
  sessionId: string;
  workspaceId: string;
  startedAt: string;
  messages: CanvasAgentMessage[];
}

// ─── Workspace context (lightweight summary) ────────────────────────

export interface NodeSummary {
  id: string;
  type: string;
  title: string;
  /** File path for file nodes, cwd for terminal/agent nodes. */
  path?: string;
  /** Agent type for agent nodes. */
  agentType?: string;
  /** Running status for agent nodes. */
  status?: string;
  /** Frame color for frame nodes. */
  color?: string;
  /** Frame label for frame nodes. */
  label?: string;
  /** Embedded URL for iframe nodes. */
  url?: string;
}

export interface WorkspaceSummary {
  workspaceId: string;
  workspaceName: string;
  canvasDir: string;
  nodeCount: number;
  nodes: NodeSummary[];
}

// ─── Events (main → renderer) ──────────────────────────────────────

export type CanvasAgentEventType =
  | 'chunk'          // streaming text delta
  | 'tool-call'      // agent is calling a tool
  | 'tool-result'    // tool call completed
  | 'done'           // turn complete
  | 'error';         // error occurred

export interface CanvasAgentEvent {
  type: CanvasAgentEventType;
  data: Record<string, unknown>;
}

// ─── IPC payloads ──────────────────────────────────────────────────

export interface ChatRequest {
  workspaceId: string;
  message: string;
}

export interface ChatResponse {
  ok: boolean;
  response?: string;
  error?: string;
}

export interface AgentStatusResponse {
  ok: boolean;
  active: boolean;
  messageCount: number;
}

export interface SessionListResponse {
  ok: boolean;
  sessions?: Array<{ sessionId: string; date: string; messageCount: number }>;
}

export interface CrossWorkspaceSessionGroup {
  workspaceId: string;
  workspaceName: string;
  sessions: Array<{
    sessionId: string;
    date: string;
    messageCount: number;
    preview: string;
    isCurrent: boolean;
  }>;
}

export interface AllSessionsResponse {
  ok: boolean;
  groups?: CrossWorkspaceSessionGroup[];
  error?: string;
}
