import { AvatarIcon, CloseIcon, ListLinesIcon, PlusIcon } from '../icons';
import type { OtherWorkspaceSession } from './types';

interface ChatHeaderProps {
  sessionMenuOpen: boolean;
  sessionMenuRef: React.RefObject<HTMLDivElement>;
  sessions: Array<{
    sessionId: string;
    date: string;
    messageCount: number;
    isCurrent: boolean;
    preview?: string;
  }>;
  otherSessions: OtherWorkspaceSession[];
  onToggleSessionMenu: () => Promise<void>;
  onNewSession: () => Promise<void>;
  onLoadSession: (sessionId: string, sourceWorkspaceId?: string) => Promise<void>;
  onClose: () => void;
  onExpand?: () => void;
}

const ExpandIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <path
      d="M9.5 2.5h4v4M13.5 2.5L9 7M6.5 13.5h-4v-4M2.5 13.5L7 9"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

export const ChatHeader = ({
  sessionMenuOpen,
  sessionMenuRef,
  sessions,
  otherSessions,
  onToggleSessionMenu,
  onNewSession,
  onLoadSession,
  onClose,
  onExpand,
}: ChatHeaderProps) => (
  <div className="chat-panel-header">
    <div className="chat-panel-title-wrapper" ref={sessionMenuRef}>
      <button className="chat-panel-title-btn" onClick={() => void onToggleSessionMenu()}>
        <AvatarIcon size={16} />
        <span>Pulse Agent</span>
        <svg className="chat-panel-title-chevron" width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {sessionMenuOpen && (
        <div className="chat-session-menu">
          <button className="chat-session-menu-new" onClick={() => void onNewSession()}>
            <PlusIcon size={14} strokeWidth={1.3} />
            <span>New chat</span>
          </button>
          {sessions.length > 0 && (
            <>
              <div className="chat-session-menu-divider" />
              <div className="chat-session-menu-label">Recent</div>
              <div className="chat-session-menu-list">
                {sessions.map(session => (
                  <button
                    key={session.sessionId}
                    className={`chat-session-menu-item${session.isCurrent ? ' chat-session-menu-item--active' : ''}`}
                    onClick={() => {
                      if (!session.isCurrent) {
                        void onLoadSession(session.sessionId);
                        return;
                      }
                      void onToggleSessionMenu();
                    }}
                  >
                    <ListLinesIcon size={14} />
                    <span className="chat-session-menu-item-text">
                      {session.isCurrent ? 'Current chat' : (session.preview || session.date)}
                    </span>
                    <span className="chat-session-menu-item-count">{session.messageCount}</span>
                  </button>
                ))}
              </div>
            </>
          )}
          {otherSessions.length > 0 && (
            <>
              <div className="chat-session-menu-divider" />
              <div className="chat-session-menu-label">Other Workspaces</div>
              <div className="chat-session-menu-list">
                {otherSessions.map(session => (
                  <button
                    key={session.sessionId}
                    className="chat-session-menu-item chat-session-menu-item--other-ws"
                    onClick={() => void onLoadSession(session.sessionId, session.sourceWorkspaceId)}
                  >
                    <ListLinesIcon size={14} />
                    <span className="chat-session-menu-item-text">
                      {session.preview || session.date}
                    </span>
                    <span className="chat-session-menu-item-ws">{session.workspaceName}</span>
                    <span className="chat-session-menu-item-count">{session.messageCount}</span>
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
    <div className="chat-panel-actions">
      <button
        className="chat-panel-action-btn"
        onClick={() => void onNewSession()}
        title="New chat"
      >
        <PlusIcon size={16} strokeWidth={1.3} />
      </button>
      {/* {onExpand && (
        <button
          className="chat-panel-action-btn"
          onClick={onExpand}
          title="Open full screen"
          aria-label="Open full screen"
        >
          <ExpandIcon size={14} />
        </button>
      )} */}
      <button className="chat-panel-action-btn" onClick={onClose} title="Close panel">
        <CloseIcon size={16} strokeWidth={1.3} />
      </button>
    </div>
  </div>
);
