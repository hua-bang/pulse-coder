import { useCallback, useEffect, useMemo, useRef } from 'react';
import type { CanvasNode } from '../../types';
import { CloseIcon, PlusIcon, SettingsIcon, SparklesIcon } from '../icons';
import './ChatPage.css';
import './ChatPanel.css';
import { ChatSessionsRail, type UnifiedSession } from './ChatSessionsRail';
import { ChatView } from './ChatView';
import { ModelSettingsDrawer } from './ModelSettings';
import { PromptSettingsDrawer } from './PromptSettings';
import { useChatComposerState } from './hooks/useChatComposerState';
import type { WorkspaceOption } from './types';

const RailToggleIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

export interface ChatPageBodyProps {
  workspaceId: string;
  /** Initial session to load on mount (only read at mount time, via ref). */
  initialPendingSessionId: string | null;
  /** Reactive pendingSessionId for same-workspace clicks after mount. */
  pendingSessionId: string | null;
  onSessionConsumed: () => void;
  onSelectSession: (session: UnifiedSession) => void;
  onWorkspaceContextRequest?: (workspaceId: string) => void;
  allWorkspaces: WorkspaceOption[];
  nodes?: CanvasNode[];
  rootFolder?: string;
  onExit: () => void;
  onNodeFocus?: (workspaceId: string, nodeId: string) => void;
  railCollapsed: boolean;
  onToggleRail: () => void;
}

export const ChatPageBody = ({
  workspaceId,
  initialPendingSessionId,
  pendingSessionId,
  onSessionConsumed,
  onSelectSession,
  onWorkspaceContextRequest,
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
    addImageToCanvas,
    answerClarification,
    attachments,
    canvasModels,
    clarifyInput,
    clearInput,
    collapsedSections,
    editableRef,
    expandedTools,
    focusInput,
    handleAttachFiles,
    handleInput,
    handleKeyDown,
    handleLoadSession,
    handleNewSession,
    handlePaste,
    input,
    loading,
    mentionIndex,
    mentionItems,
    mentionOpen,
    messageTools,
    messages,
    modelSettingsOpen,
    setModelSettingsOpen,
    otherSessions,
    pendingClarify,
    promptProfile,
    promptSettingsOpen,
    setPromptSettingsOpen,
    removeAttachment,
    selectMention,
    sendMessage,
    sessions,
    setClarifyInput,
    setMentionIndex,
    streamingTools,
    submitCurrentInput,
    toggleSection,
    toggleToolExpand,
  } = useChatComposerState({
    workspaceId,
    allWorkspaces,
    nodes,
    rootFolder,
    eagerLoad: true,
    // If we're about to load a specific session on mount, don't also fetch
    // the current active-session history — it would race with the pending
    // load and potentially overwrite it.
    skipInitialHistory: initialPendingRef.current !== null,
  });

  useEffect(() => {
    onWorkspaceContextRequest?.(workspaceId);
  }, [onWorkspaceContextRequest, workspaceId]);

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
    onNodeFocus?.(workspaceId, nodeId);
    onExit();
  }, [onExit, onNodeFocus, workspaceId]);

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
    <>
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
            onClick={() => setPromptSettingsOpen(true)}
            title="回复风格 / 自定义提示词"
            aria-label="Reply style and custom prompt"
          >
            <SparklesIcon size={16} strokeWidth={1.25} />
          </button>
          <button
            className="chat-panel-action-btn"
            onClick={() => setModelSettingsOpen(true)}
            title="AI model settings"
            aria-label="AI model settings"
          >
            <SettingsIcon size={16} strokeWidth={1.25} />
          </button>
          <button
            className="chat-panel-action-btn"
            onClick={() => void handleNewSession()}
            title="New AI chat"
            aria-label="New AI chat"
          >
            <PlusIcon size={16} strokeWidth={1.3} />
          </button>
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
          workspaceId={workspaceId}
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
          onAddImageToCanvas={addImageToCanvas}
          nodes={nodes}
          onNodeFocus={handleNodeFocus}
          onQuickAction={handleQuickAction}
          input={input}
          attachments={attachments}
          editableRef={editableRef}
          mentionOpen={mentionOpen}
          mentionItems={mentionItems}
          mentionIndex={mentionIndex}
          onSelectMention={selectMention}
          onMentionIndexChange={setMentionIndex}
          onInput={handleInput}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onAttachFiles={handleAttachFiles}
          onRemoveAttachment={removeAttachment}
          onSubmit={submitCurrentInput}
          onAbort={abort}
          modelStatus={canvasModels.status}
          modelSelection={canvasModels.selection}
          modelLabel={canvasModels.selectedLabel}
          onSelectAutoModel={canvasModels.selectAuto}
          onSelectModel={canvasModels.selectModel}
          onOpenModelSettings={() => setModelSettingsOpen(true)}
          contextComposer
        />
      </div>
    </div>
    <ModelSettingsDrawer
      open={modelSettingsOpen}
      status={canvasModels.status}
      error={canvasModels.error}
      onClose={() => setModelSettingsOpen(false)}
      onSaveProvider={canvasModels.upsertProvider}
      onRemoveProvider={canvasModels.removeProvider}
      onFetchModels={canvasModels.fetchModels}
    />
    <PromptSettingsDrawer
      open={promptSettingsOpen}
      profile={promptProfile.profile}
      error={promptProfile.error}
      onClose={() => setPromptSettingsOpen(false)}
      onSave={promptProfile.save}
      onReset={promptProfile.reset}
    />
    </>
  );
};
