import { useCallback, useEffect, useRef } from 'react';
import type { AgentChatMessage, CanvasNode } from '../../types';
import { AvatarIcon } from '../icons';
import { ChatMessage } from './ChatMessage';
import type { PendingClarification, ToolCallStatus } from './types';

interface ChatMessagesProps {
  messages: AgentChatMessage[];
  loading: boolean;
  nodes?: CanvasNode[];
  streamingTools: ToolCallStatus[];
  messageTools: Map<number, ToolCallStatus[]>;
  collapsedSections: Set<number>;
  expandedTools: Set<number>;
  pendingClarify: PendingClarification | null;
  clarifyInput: string;
  onClarifyInputChange: (value: string) => void;
  onAnswerClarification: () => Promise<void>;
  onToggleSection: (messageIndex: number) => void;
  onToggleToolExpand: (toolId: number) => void;
  onNodeFocus?: (nodeId: string) => void;
}

const LoadingPlaceholder = () => (
  <div className="chat-message chat-message-assistant">
    <div className="chat-message-avatar">
      <AvatarIcon size={14} />
    </div>
    <div className="chat-message-body">
      <div className="chat-loading">
        <div className="chat-loading-dot" />
        <div className="chat-loading-dot" />
        <div className="chat-loading-dot" />
      </div>
    </div>
  </div>
);

const ClarificationCard = ({
  pendingClarify,
  clarifyInput,
  onClarifyInputChange,
  onAnswerClarification,
}: {
  pendingClarify: PendingClarification;
  clarifyInput: string;
  onClarifyInputChange: (value: string) => void;
  onAnswerClarification: () => Promise<void>;
}) => (
  <div className="chat-message chat-message-assistant">
    <div className="chat-message-avatar">
      <AvatarIcon size={14} />
    </div>
    <div className="chat-message-body">
      <div className="chat-clarify-card">
        <div className="chat-clarify-label">Needs clarification</div>
        <div className="chat-clarify-question">{pendingClarify.question}</div>
        {pendingClarify.context && (
          <div className="chat-clarify-context">{pendingClarify.context}</div>
        )}
        <div className="chat-clarify-form">
          <input
            type="text"
            className="chat-clarify-input"
            value={clarifyInput}
            onChange={(event) => onClarifyInputChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void onAnswerClarification();
              }
            }}
            placeholder="Type your answer…"
            autoFocus
          />
          <button
            className="chat-clarify-submit"
            onClick={() => void onAnswerClarification()}
            disabled={!clarifyInput.trim()}
          >
            Reply
          </button>
        </div>
      </div>
    </div>
  </div>
);

export const ChatMessages = ({
  messages,
  loading,
  nodes,
  streamingTools,
  messageTools,
  collapsedSections,
  expandedTools,
  pendingClarify,
  clarifyInput,
  onClarifyInputChange,
  onAnswerClarification,
  onToggleSection,
  onToggleToolExpand,
  onNodeFocus,
}: ChatMessagesProps) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, pendingClarify, streamingTools]);

  const handleMessageClick = useCallback((event: React.MouseEvent) => {
    const chip = (event.target as HTMLElement).closest('.chat-mention-chip--clickable') as HTMLElement | null;
    if (!chip || !onNodeFocus) return;
    const nodeId = chip.dataset.nodeId;
    if (nodeId) {
      onNodeFocus(nodeId);
    }
  }, [onNodeFocus]);

  const hasStreamingAssistantMessage = loading
    && messages.length > 0
    && messages[messages.length - 1].role === 'assistant';

  return (
    <div className="chat-messages" onClick={handleMessageClick}>
      {messages.map((message, index) => {
        const isStreaming = loading && message.role === 'assistant' && index === messages.length - 1;
        const tools = isStreaming ? streamingTools : messageTools.get(index);
        return (
          <ChatMessage
            key={index}
            message={message}
            isStreaming={isStreaming}
            loading={loading}
            tools={tools}
            collapsed={collapsedSections.has(index)}
            expandedTools={expandedTools}
            nodes={nodes}
            onToggleSection={() => onToggleSection(index)}
            onToggleToolExpand={onToggleToolExpand}
          />
        );
      })}
      {loading && !hasStreamingAssistantMessage && <LoadingPlaceholder />}
      {pendingClarify && (
        <ClarificationCard
          pendingClarify={pendingClarify}
          clarifyInput={clarifyInput}
          onClarifyInputChange={onClarifyInputChange}
          onAnswerClarification={onAnswerClarification}
        />
      )}
      <div ref={messagesEndRef} />
    </div>
  );
};
