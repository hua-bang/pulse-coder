import { QUICK_ACTIONS } from './constants';
import type { QuickAction } from './types';

function QuickActionIcon({ action }: { action: QuickAction }) {
  switch (action.key) {
    case 'overview':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.3" />
          <path d="M11 11l3 3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'note':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
          <path d="M6 8h4M8 6v4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'summarize':
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M2 4h12M2 8h8M2 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        </svg>
      );
    case 'command':
    default:
      return (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
          <path d="M4 6l2.5 2L4 10M8 10h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="1.5" y="2" width="13" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
        </svg>
      );
  }
}

interface ChatEmptyStateProps {
  onQuickAction: (prompt: string) => void;
}

export const ChatEmptyState = ({ onQuickAction }: ChatEmptyStateProps) => (
  <div className="chat-empty-state">
    <div className="chat-empty-icon">
      <svg width="32" height="32" viewBox="0 0 32 32" fill="none">
        <circle cx="16" cy="12" r="6" stroke="currentColor" strokeWidth="1.5" />
        <path d="M8 28c0-4.4 3.6-8 8-8s8 3.6 8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
        <circle cx="13.5" cy="11" r="1" fill="currentColor" />
        <circle cx="18.5" cy="11" r="1" fill="currentColor" />
        <path d="M13.5 14c0 0 1 1.5 2.5 1.5s2.5-1.5 2.5-1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </svg>
    </div>
    <div className="chat-empty-greeting">Hi, how can I help?</div>
    <div className="chat-quick-actions">
      {QUICK_ACTIONS.map(action => (
        <button
          key={action.key}
          className="chat-quick-action"
          onClick={() => onQuickAction(action.prompt)}
        >
          <span className="chat-quick-action-icon">
            <QuickActionIcon action={action} />
          </span>
          <span>{action.label}</span>
        </button>
      ))}
    </div>
  </div>
);
