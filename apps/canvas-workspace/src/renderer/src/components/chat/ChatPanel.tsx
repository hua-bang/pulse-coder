import { useCallback } from 'react';
import { ChatHeader } from './ChatHeader';
import './ChatPanel.css';
import { ChatView } from './ChatView';
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
  onExpand,
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

  return (
    <ChatView
      className="chat-panel"
      onResizeStart={onResizeStart}
      header={
        <ChatHeader
          sessionMenuOpen={sessionMenuOpen}
          sessionMenuRef={sessionMenuRef}
          sessions={sessions}
          otherSessions={otherSessions}
          onToggleSessionMenu={openSessionMenu}
          onNewSession={handleNewSession}
          onLoadSession={handleLoadSession}
          onClose={onClose}
          onExpand={onExpand}
        />
      }
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
      onNodeFocus={onNodeFocus}
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
  );
};
