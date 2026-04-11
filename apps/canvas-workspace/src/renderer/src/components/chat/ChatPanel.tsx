import { useCallback } from 'react';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatHeader } from './ChatHeader';
import { ChatInput } from './ChatInput';
import { ChatMentionPopup } from './ChatMentionPopup';
import { ChatMessages } from './ChatMessages';
import './ChatPanel.css';
import { useChatSessions } from './hooks/useChatSessions';
import { useChatStream } from './hooks/useChatStream';
import { useMentions } from './hooks/useMentions';
import type { ChatPanelProps } from './types';

export const ChatPanel = ({
  workspaceId,
  allWorkspaces,
  nodes,
  rootFolder,
  onClose,
  onResizeStart,
  onNodeFocus,
}: ChatPanelProps) => {
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
    openSessionMenu,
    sessionMenuOpen,
    sessionMenuRef,
    sessions,
  } = useChatSessions({
    workspaceId,
    allWorkspaces,
    onMessagesLoaded: replaceMessages,
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

  const hasMessages = messages.length > 0 || loading;

  return (
    <div className="chat-panel">
      {onResizeStart && (
        <div className="chat-panel-resize" onMouseDown={onResizeStart} />
      )}
      <ChatHeader
        sessionMenuOpen={sessionMenuOpen}
        sessionMenuRef={sessionMenuRef}
        sessions={sessions}
        otherSessions={otherSessions}
        onToggleSessionMenu={openSessionMenu}
        onNewSession={handleNewSession}
        onLoadSession={handleLoadSession}
        onClose={onClose}
      />
      {hasMessages ? (
        <ChatMessages
          messages={messages}
          loading={loading}
          nodes={nodes}
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
          onNodeFocus={onNodeFocus}
        />
      ) : (
        <ChatEmptyState onQuickAction={handleQuickAction} />
      )}
      <ChatInput
        loading={loading}
        input={input}
        editableRef={editableRef}
        mentionPopup={mentionOpen && mentionItems.length > 0 ? (
          <ChatMentionPopup
            mentionItems={mentionItems}
            mentionIndex={mentionIndex}
            onSelectMention={selectMention}
            onMentionIndexChange={setMentionIndex}
          />
        ) : undefined}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        onSend={submitCurrentInput}
        onAbort={abort}
      />
    </div>
  );
};
