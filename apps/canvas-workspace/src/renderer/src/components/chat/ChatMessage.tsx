import type { AgentChatMessage, CanvasNode } from '../../types';
import { AvatarIcon } from '../icons';
import type { ToolCallStatus } from './types';
import { renderMdWithMentions, renderUserContent } from './utils/mentions';
import { ChatToolCalls } from './ChatToolCalls';

interface ChatMessageProps {
  message: AgentChatMessage;
  isStreaming: boolean;
  loading: boolean;
  tools?: ToolCallStatus[];
  collapsed: boolean;
  expandedTools: Set<number>;
  nodes?: CanvasNode[];
  onToggleSection: () => void;
  onToggleToolExpand: (toolId: number) => void;
}

const LoadingDots = () => (
  <div className="chat-loading">
    <div className="chat-loading-dot" />
    <div className="chat-loading-dot" />
    <div className="chat-loading-dot" />
  </div>
);

export const ChatMessage = ({
  message,
  isStreaming,
  loading,
  tools,
  collapsed,
  expandedTools,
  nodes,
  onToggleSection,
  onToggleToolExpand,
}: ChatMessageProps) => (
  <div className={`chat-message chat-message-${message.role}`}>
    {message.role === 'assistant' && (
      <div className="chat-message-avatar">
        <AvatarIcon size={14} />
      </div>
    )}
    <div className="chat-message-body">
      {message.role === 'assistant' && tools && tools.length > 0 && (
        <ChatToolCalls
          tools={tools}
          collapsed={collapsed}
          expandedTools={expandedTools}
          showSectionHeader={!loading}
          onToggleSection={onToggleSection}
          onToggleToolExpand={onToggleToolExpand}
        />
      )}
      {message.role === 'assistant' ? (
        isStreaming ? (
          message.content ? (
            <div
              className="chat-message-content chat-md chat-md--streaming"
              dangerouslySetInnerHTML={{ __html: renderMdWithMentions(message.content, nodes) }}
            />
          ) : (!tools || tools.length === 0) ? (
            <LoadingDots />
          ) : null
        ) : (
          <div
            className="chat-message-content chat-md"
            dangerouslySetInnerHTML={{ __html: renderMdWithMentions(message.content, nodes) }}
          />
        )
      ) : (
        <div className="chat-message-content">{renderUserContent(message.content, nodes)}</div>
      )}
    </div>
  </div>
);
