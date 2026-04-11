import type {
  ClipboardEventHandler,
  KeyboardEventHandler,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  RefObject,
} from 'react';
import type { AgentChatMessage, CanvasNode } from '../../types';
import { ChatEmptyState } from './ChatEmptyState';
import { ChatInput } from './ChatInput';
import { ChatMentionPopup } from './ChatMentionPopup';
import { ChatMessages } from './ChatMessages';
import type { MentionItem, PendingClarification, ToolCallStatus } from './types';

interface ChatViewProps {
  className?: string;
  header?: ReactNode;
  beforeHeader?: ReactNode;

  // Streaming + messages
  messages: AgentChatMessage[];
  loading: boolean;
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

  // Canvas context
  nodes?: CanvasNode[];
  onNodeFocus?: (nodeId: string) => void;

  // Quick actions (empty state)
  onQuickAction: (prompt: string) => Promise<void> | void;

  // Input
  input: string;
  editableRef: RefObject<HTMLDivElement>;
  mentionOpen: boolean;
  mentionItems: MentionItem[];
  mentionIndex: number;
  onSelectMention: (item: MentionItem) => void;
  onMentionIndexChange: (index: number) => void;
  onInput: () => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onPaste: ClipboardEventHandler<HTMLDivElement>;
  onSubmit: () => Promise<boolean>;
  onAbort: () => Promise<void>;

  // Optional decoration
  onResizeStart?: (e: ReactMouseEvent) => void;
}

/**
 * Presentational body used by both ChatPanel (narrow right-side panel) and
 * ChatPage (full-screen page). Owns no state; callers pass the result of
 * useChatStream + useChatSessions + useMentions.
 */
export const ChatView = ({
  className,
  header,
  beforeHeader,
  messages,
  loading,
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
  nodes,
  onNodeFocus,
  onQuickAction,
  input,
  editableRef,
  mentionOpen,
  mentionItems,
  mentionIndex,
  onSelectMention,
  onMentionIndexChange,
  onInput,
  onKeyDown,
  onPaste,
  onSubmit,
  onAbort,
  onResizeStart,
}: ChatViewProps) => {
  const hasMessages = messages.length > 0 || loading;

  return (
    <div className={className ?? 'chat-view'}>
      {onResizeStart && (
        <div className="chat-panel-resize" onMouseDown={onResizeStart} />
      )}
      {beforeHeader}
      {header}
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
          onClarifyInputChange={onClarifyInputChange}
          onAnswerClarification={onAnswerClarification}
          onToggleSection={onToggleSection}
          onToggleToolExpand={onToggleToolExpand}
          onNodeFocus={onNodeFocus}
        />
      ) : (
        <ChatEmptyState onQuickAction={onQuickAction} />
      )}
      <ChatInput
        loading={loading}
        input={input}
        editableRef={editableRef}
        mentionPopup={mentionOpen && mentionItems.length > 0 ? (
          <ChatMentionPopup
            mentionItems={mentionItems}
            mentionIndex={mentionIndex}
            onSelectMention={onSelectMention}
            onMentionIndexChange={onMentionIndexChange}
          />
        ) : undefined}
        onInput={onInput}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onSend={onSubmit}
        onAbort={onAbort}
      />
    </div>
  );
};
