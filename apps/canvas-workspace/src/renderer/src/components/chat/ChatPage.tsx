import { useCallback } from 'react';
import type { CanvasNode } from '../../types';
import { CloseIcon } from '../icons';
import './ChatPage.css';
import './ChatPanel.css';
import { ChatSessionsRail } from './ChatSessionsRail';
import { ChatView } from './ChatView';
import { useChatSessions } from './hooks/useChatSessions';
import { useChatStream } from './hooks/useChatStream';
import { useMentions } from './hooks/useMentions';
import type { WorkspaceOption } from './types';

interface ChatPageProps {
  workspaceId: string;
  allWorkspaces: WorkspaceOption[];
  nodes?: CanvasNode[];
  rootFolder?: string;
  onExit: () => void;
  onSelectWorkspace?: (id: string) => void;
  onNodeFocus?: (nodeId: string) => void;
}

/**
 * Full-screen AI Chat page. Reuses the same hooks and body as ChatPanel via
 * ChatView, but adds a visible sessions rail and a wider main column.
 *
 * Mutual exclusion with ChatPanel is enforced at the App level — only one
 * surface should be mounted at a time to avoid duplicate IPC subscriptions.
 */
export const ChatPage = ({
  workspaceId,
  allWorkspaces,
  nodes,
  rootFolder,
  onExit,
  onSelectWorkspace,
  onNodeFocus,
}: ChatPageProps) => {
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

  const activeWorkspace = allWorkspaces.find((ws) => ws.id === workspaceId);

  return (
    <div className="chat-page">
      <ChatSessionsRail
        sessions={sessions}
        otherSessions={otherSessions}
        onNewSession={handleNewSession}
        onLoadSession={handleLoadSession}
      />

      <div className="chat-page-main">
        <div className="chat-page-topbar">
          {allWorkspaces.length > 1 && onSelectWorkspace ? (
            <label className="chat-page-workspace-switcher">
              <span className="chat-page-workspace-label">Workspace</span>
              <select
                className="chat-page-workspace-select"
                value={workspaceId}
                onChange={(event) => onSelectWorkspace(event.target.value)}
              >
                {allWorkspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>{ws.name}</option>
                ))}
              </select>
            </label>
          ) : (
            <span className="chat-page-workspace-name">
              {activeWorkspace?.name ?? 'Workspace'}
            </span>
          )}

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
