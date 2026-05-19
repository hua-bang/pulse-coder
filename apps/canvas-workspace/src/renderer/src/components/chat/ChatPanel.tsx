import { useCallback, useMemo, useRef, useState } from 'react';
import { ChatHeader } from './ChatHeader';
import './ChatPanel.css';
import { ChatView } from './ChatView';
import { ModelSettingsDrawer } from './ModelSettings';
import { PromptSettingsDrawer } from './PromptSettings';
import { useChatComposerState } from './hooks/useChatComposerState';
import { getNodeDisplayLabel } from '../../utils/nodeLabel';
import type { AgentRequestContext } from '../../types';
import type { ChatPanelProps } from './types';

export const ChatPanel = ({
  workspaceId,
  allWorkspaces,
  nodes,
  selectedNodeIds,
  rootFolder,
  onClose,
  onResizeStart,
  onNodeFocus,
}: ChatPanelProps) => {
  const [executionMode, setExecutionMode] = useState<'auto' | 'ask'>('auto');
  const requestContextRef = useRef<AgentRequestContext>();

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
    openSessionMenu,
    otherSessions,
    pendingClarify,
    promptProfile,
    promptSettingsOpen,
    setPromptSettingsOpen,
    removeAttachment,
    selectMention,
    sendMessage,
    sessionMenuOpen,
    sessionMenuRef,
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
    getRequestContext: () => requestContextRef.current,
  });

  const selectedNodes = useMemo(() => {
    const ids = new Set(selectedNodeIds ?? []);
    return (nodes ?? []).filter(node => ids.has(node.id));
  }, [nodes, selectedNodeIds]);

  const requestContext = useMemo<AgentRequestContext>(() => ({
    executionMode,
    scope: selectedNodes.length > 0 ? 'selected_nodes' : 'current_canvas',
    selectedNodes: selectedNodes.map(node => ({
      id: node.id,
      title: getNodeDisplayLabel(node),
      type: node.type,
    })),
  }), [executionMode, selectedNodes]);

  requestContextRef.current = requestContext;

  const sessionTitle = useMemo(() => {
    const firstUserMessage = messages.find(message => message.role === 'user')?.content.trim();
    if (!firstUserMessage) return 'New AI chat';
    const cleaned = firstUserMessage
      .replace(/@\[[^\]]+\]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    const fallback = requestContext.scope === 'selected_nodes' ? '整理选中节点' : '分析当前画布';
    const title = cleaned || fallback;
    return title.length > 24 ? `${title.slice(0, 23)}…` : title;
  }, [messages, requestContext.scope]);

  const handleQuickAction = useCallback(async (prompt: string, quickAction?: string) => {
    if (!prompt) {
      focusInput();
      return;
    }

    const ok = await sendMessage(prompt, { ...requestContext, quickAction });
    if (ok) {
      clearInput();
    }
  }, [clearInput, focusInput, requestContext, sendMessage]);

  const handleSubmit = useCallback(async () => {
    return await submitCurrentInput(requestContext);
  }, [requestContext, submitCurrentInput]);

  const handleToggleExecutionMode = useCallback(() => {
    setExecutionMode(mode => mode === 'auto' ? 'ask' : 'auto');
  }, []);

  return (
    <>
      <ChatView
      className="chat-panel"
      onResizeStart={onResizeStart}
      header={
        <ChatHeader
          sessionMenuOpen={sessionMenuOpen}
          sessionMenuRef={sessionMenuRef}
          sessions={sessions}
          otherSessions={otherSessions}
          title={sessionTitle}
          onToggleSessionMenu={openSessionMenu}
          onNewSession={handleNewSession}
          onOpenModelSettings={() => setModelSettingsOpen(true)}
          onOpenPromptSettings={() => setPromptSettingsOpen(true)}
          onLoadSession={handleLoadSession}
          onClose={onClose}
        />
      }
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
      selectedNodes={selectedNodes}
      onNodeFocus={onNodeFocus}
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
      onSubmit={handleSubmit}
      onAbort={abort}
      modelStatus={canvasModels.status}
      modelSelection={canvasModels.selection}
      modelLabel={canvasModels.selectedLabel}
      onSelectAutoModel={canvasModels.selectAuto}
      onSelectModel={canvasModels.selectModel}
      onOpenModelSettings={() => setModelSettingsOpen(true)}
      contextComposer
      executionMode={executionMode}
      onToggleExecutionMode={handleToggleExecutionMode}
    />
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
