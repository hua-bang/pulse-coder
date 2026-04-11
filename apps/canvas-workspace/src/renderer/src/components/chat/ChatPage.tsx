import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CanvasNode } from '../../types';
import { CloseIcon } from '../icons';
import './ChatPage.css';
import './ChatPanel.css';
import { ChatSessionsRail, type UnifiedSession } from './ChatSessionsRail';
import { ChatView } from './ChatView';
import { useChatSessions } from './hooks/useChatSessions';
import { useChatStream } from './hooks/useChatStream';
import { useMentions } from './hooks/useMentions';
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

const RailToggleIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

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

interface ChatPageBodyProps {
  workspaceId: string;
  /** Initial session to load on mount (only read at mount time, via ref). */
  initialPendingSessionId: string | null;
  /** Reactive pendingSessionId for same-workspace clicks after mount. */
  pendingSessionId: string | null;
  onSessionConsumed: () => void;
  onSelectSession: (session: UnifiedSession) => void;
  allWorkspaces: WorkspaceOption[];
  nodes?: CanvasNode[];
  rootFolder?: string;
  onExit: () => void;
  onNodeFocus?: (nodeId: string) => void;
  railCollapsed: boolean;
  onToggleRail: () => void;
}

const ChatPageBody = ({
  workspaceId,
  initialPendingSessionId,
  pendingSessionId,
  onSessionConsumed,
  onSelectSession,
  allWorkspaces,
  nodes,
  rootFolder,
  onExit,
  onNodeFocus,
  railCollapsed,
  onToggleRail,
}: ChatPageBodyProps) => {
  // Snapshot at mount: the caller might change pendingSessionId later (e.g.
  // for a same-workspace click), but on mount we only care about the value
  // we saw when this body was constructed (after a workspace switch).
  const initialPendingRef = useRef(initialPendingSessionId);

  const {
    abort,
    answerClarification,
    clarifyInput,
    collapsedSections,
    expandedTools,
    loading,
    messageTools,
    messages,
    pendingClarify,
    replaceMessages,
    sendMessage,
    setClarifyInput,
    streamingTools,
    toggleSection,
    toggleToolExpand,
  } = useChatStream({ workspaceId, allWorkspaces });

  const {
    otherSessions,
    handleLoadSession,
    handleNewSession,
    sessions,
  } = useChatSessions({
    workspaceId,
    allWorkspaces,
    onMessagesLoaded: replaceMessages,
    eagerLoad: true,
    // If we're about to load a specific session on mount, don't also fetch
    // the current active-session history — it would race with the pending
    // load and potentially overwrite it.
    skipInitialHistory: initialPendingRef.current !== null,
  });

  const {
    clearInput,
    editableRef,
    focusInput,
    handleInput,
    handleKeyDown,
    handlePaste,
    input,
    mentionIndex,
    mentionItems,
    mentionOpen,
    selectMention,
    setMentionIndex,
    submitCurrentInput,
  } = useMentions({
    allWorkspaces,
    workspaceId,
    nodes,
    rootFolder,
    onSubmit: sendMessage,
  });

  // Load the pending session whenever it's set. This uniformly handles both
  // cases:
  //   - Cross-workspace mount: body was just created with a non-null
  //     pendingSessionId from the parent, so the effect fires on first run.
  //   - Same-workspace click after mount: parent bumps pendingSessionId from
  //     null to something, so the effect fires on the subsequent render.
  useEffect(() => {
    if (pendingSessionId === null) return;
    void handleLoadSession(pendingSessionId).then(() => {
      onSessionConsumed();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSessionId]);

  const handleQuickAction = useCallback(async (prompt: string) => {
    if (!prompt) {
      focusInput();
      return;
    }

    const ok = await sendMessage(prompt);
    if (ok) {
      clearInput();
    }
  }, [clearInput, focusInput, sendMessage]);

  // Clicking a mention chip should jump back to the canvas and focus the node.
  const handleNodeFocus = useCallback((nodeId: string) => {
    onNodeFocus?.(nodeId);
    onExit();
  }, [onExit, onNodeFocus]);

  // Merge sessions from the current workspace with sessions from every other
  // workspace into a single list, sorted by date (newest first).
  const allSessions: UnifiedSession[] = useMemo(() => {
    const currentWorkspaceName =
      allWorkspaces.find((w) => w.id === workspaceId)?.name ?? workspaceId;

    const unified: UnifiedSession[] = [
      ...sessions.map((s) => ({
        sessionId: s.sessionId,
        workspaceId,
        workspaceName: currentWorkspaceName,
        date: s.date,
        messageCount: s.messageCount,
        preview: s.preview,
        isCurrent: s.isCurrent,
      })),
      ...otherSessions.map((os) => ({
        sessionId: os.sessionId,
        workspaceId: os.sourceWorkspaceId,
        workspaceName: os.workspaceName,
        date: os.date,
        messageCount: os.messageCount,
        preview: os.preview,
        isCurrent: false,
      })),
    ];

    unified.sort((a, b) => b.date.localeCompare(a.date));
    return unified;
  }, [sessions, otherSessions, workspaceId, allWorkspaces]);

  return (
    <div className="chat-page">
      <div className={`chat-page-rail-wrapper${railCollapsed ? ' chat-page-rail-wrapper--collapsed' : ''}`}>
        <ChatSessionsRail
          allSessions={allSessions}
          onNewSession={handleNewSession}
          onSelectSession={onSelectSession}
        />
      </div>

      <div className="chat-page-main">
        <div className="chat-page-topbar">
          <button
            className="chat-panel-action-btn"
            onClick={onToggleRail}
            title={railCollapsed ? 'Show session list' : 'Hide session list'}
            aria-label={railCollapsed ? 'Show session list' : 'Hide session list'}
          >
            <RailToggleIcon size={16} />
          </button>
          <div className="chat-page-topbar-spacer" />
          <button
            className="chat-panel-action-btn"
            onClick={onExit}
            title="Back to canvas (Esc)"
            aria-label="Back to canvas"
          >
            <CloseIcon size={16} strokeWidth={1.3} />
          </button>
        </div>

        <ChatView
          className="chat-page-body"
          messages={messages}
          loading={loading}
          streamingTools={streamingTools}
          messageTools={messageTools}
          collapsedSections={collapsedSections}
          expandedTools={expandedTools}
          pendingClarify={pendingClarify}
          clarifyInput={clarifyInput}
          onClarifyInputChange={setClarifyInput}
          onAnswerClarification={answerClarification}
          onToggleSection={toggleSection}
          onToggleToolExpand={toggleToolExpand}
          nodes={nodes}
          onNodeFocus={handleNodeFocus}
          onQuickAction={handleQuickAction}
          input={input}
          editableRef={editableRef}
          mentionOpen={mentionOpen}
          mentionItems={mentionItems}
          mentionIndex={mentionIndex}
          onSelectMention={selectMention}
          onMentionIndexChange={setMentionIndex}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onSubmit={submitCurrentInput}
          onAbort={abort}
        />
      </div>
    </div>
  );
};
