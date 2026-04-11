import { MENTION_GROUP_LABEL, getMentionGroupKey } from './constants';
import type { MentionItem } from './types';
import { MentionNodeIcon } from './utils/mentions';

interface ChatMentionPopupProps {
  mentionItems: MentionItem[];
  mentionIndex: number;
  onSelectMention: (item: MentionItem) => void;
  onMentionIndexChange: (index: number) => void;
}

export const ChatMentionPopup = ({
  mentionItems,
  mentionIndex,
  onSelectMention,
  onMentionIndexChange,
}: ChatMentionPopupProps) => (
  <div className="chat-mention-popup">
    {mentionItems.map((item, index) => {
      const groupKey = getMentionGroupKey(item);
      const previousGroupKey = index > 0 ? getMentionGroupKey(mentionItems[index - 1]) : null;
      const showHeader = previousGroupKey !== groupKey;
      const nodeType = item.type === 'workspace'
        ? 'workspace'
        : item.type === 'node'
          ? item.nodeType ?? 'file'
          : 'file';

      return (
        <div key={`${item.type}-${item.nodeType ?? ''}-${item.workspaceId ?? ''}-${item.label}-${index}`}>
          {showHeader && (
            <div className="chat-mention-group-header">{MENTION_GROUP_LABEL[groupKey]}</div>
          )}
          <button
            className={`chat-mention-item${index === mentionIndex ? ' chat-mention-item--active' : ''}`}
            onMouseDown={(event) => {
              event.preventDefault();
              onSelectMention(item);
            }}
            onMouseEnter={() => onMentionIndexChange(index)}
          >
            <span className="chat-mention-item-icon">
              <MentionNodeIcon size={14} nodeType={nodeType} />
            </span>
            <span className="chat-mention-item-label">{item.label}</span>
          </button>
        </div>
      );
    })}
  </div>
);
