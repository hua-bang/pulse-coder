import { useCallback, useState } from 'react';
import type { CanvasNode } from '../../types';
import type { UnifiedSession } from './ChatSessionsRail';
import { ChatPageBody } from './ChatPageBody';
import type { WorkspaceOption } from './types';

interface ChatPageProps {
  /**
   * Initial workspace to use as the chat's backend binding. The chat page
   * tracks its own current-workspace state internally after that — it does
   * NOT stay in sync with the app-level activeId. Switching workspaces from
   * the chat page only happens when the user clicks a session belonging to
   * another workspace.
   */
  initialWorkspaceId: string;
  allWorkspaces: WorkspaceOption[];
  nodes?: CanvasNode[];
  rootFolder?: string;
  onExit: () => void;
  onNodeFocus?: (nodeId: string) => void;
}

/**
 * Full-screen AI Chat page. Decoupled from the app-level activeId — the
 * page treats sessions as the primary unit and has no visible "selected
 * workspace" concept. Workspace is purely metadata on each session.
 *
 * Structure:
 *   - Outer ChatPage: owns currentWorkspaceId + pendingSessionId state.
 *     Remounts the inner body (React key) when the workspace changes so the
 *     hook subscriptions are rebuilt cleanly against the new workspace.
 *   - Inner ChatPageBody: owns the streaming / session / mention hooks. On
 *     mount, loads `initialPendingSessionId` if provided (used when the
 *     user picked a cross-workspace session in the rail).
 *
 * Mutual exclusion with ChatPanel is enforced at the App level.
 */
export const ChatPage = ({
  initialWorkspaceId,
  allWorkspaces,
  nodes,
  rootFolder,
  onExit,
  onNodeFocus,
}: ChatPageProps) => {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null);
  const [railCollapsed, setRailCollapsed] = useState(false);

  // Same-workspace session click → just bump pendingSessionId without
  // remounting the body. Cross-workspace click → change workspaceId which
  // triggers the body remount, and the new body mount effect will pick up
  // initialPendingSessionId.
  const handleSelectSession = useCallback((session: UnifiedSession) => {
    if (session.workspaceId === workspaceId) {
      setPendingSessionId(session.sessionId);
      return;
    }
    setWorkspaceId(session.workspaceId);
    setPendingSessionId(session.sessionId);
  }, [workspaceId]);

  const handleSessionConsumed = useCallback(() => {
    setPendingSessionId(null);
  }, []);

  const handleToggleRail = useCallback(() => {
    setRailCollapsed((v) => !v);
  }, []);

  return (
    <ChatPageBody
      key={workspaceId}
      workspaceId={workspaceId}
      initialPendingSessionId={pendingSessionId}
      pendingSessionId={pendingSessionId}
      onSessionConsumed={handleSessionConsumed}
      onSelectSession={handleSelectSession}
      allWorkspaces={allWorkspaces}
      nodes={nodes}
      rootFolder={rootFolder}
      onExit={onExit}
      onNodeFocus={onNodeFocus}
      railCollapsed={railCollapsed}
      onToggleRail={handleToggleRail}
    />
  );
};
