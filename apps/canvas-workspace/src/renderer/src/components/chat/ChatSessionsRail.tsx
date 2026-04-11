import type { AgentSessionInfo } from '../../types';
import { ListLinesIcon, PlusIcon } from '../icons';
import type { OtherWorkspaceSession } from './types';

interface ChatSessionsRailProps {
  sessions: AgentSessionInfo[];
  otherSessions: OtherWorkspaceSession[];
  onNewSession: () => Promise<void>;
  onLoadSession: (sessionId: string, sourceWorkspaceId?: string) => Promise<void>;
}

/**
 * Always-visible sessions rail shown in ChatPage. This is the full-screen
 * equivalent of the dropdown menu in ChatHeader (panel).
 */
export const ChatSessionsRail = ({
  sessions,
  otherSessions,
  onNewSession,
  onLoadSession,
}: ChatSessionsRailProps) => (
  <aside className="chat-page-rail">
    <button
      className="chat-page-rail-new"
      onClick={() => void onNewSession()}
    >
      <PlusIcon size={14} strokeWidth={1.3} />
      <span>New chat</span>
    </button>

    {sessions.length > 0 && (
      <div className="chat-page-rail-group">
        <div className="chat-page-rail-label">Recent</div>
        <div className="chat-page-rail-list">
          {sessions.map((session) => (
            <button
              key={session.sessionId}
              className={`chat-page-rail-item${session.isCurrent ? ' chat-page-rail-item--active' : ''}`}
              onClick={() => {
                if (session.isCurrent) return;
                void onLoadSession(session.sessionId);
              }}
              title={session.preview || session.date}
            >
              <ListLinesIcon size={14} />
              <span className="chat-page-rail-item-text">
                {session.isCurrent ? 'Current chat' : (session.preview || session.date)}
              </span>
              <span className="chat-page-rail-item-count">{session.messageCount}</span>
            </button>
          ))}
        </div>
      </div>
    )}

    {otherSessions.length > 0 && (
      <div className="chat-page-rail-group">
        <div className="chat-page-rail-label">Other Workspaces</div>
        <div className="chat-page-rail-list">
          {otherSessions.map((session) => (
            <button
              key={`${session.sourceWorkspaceId}:${session.sessionId}`}
              className="chat-page-rail-item chat-page-rail-item--other"
              onClick={() => void onLoadSession(session.sessionId, session.sourceWorkspaceId)}
              title={`${session.workspaceName} · ${session.preview || session.date}`}
            >
              <ListLinesIcon size={14} />
              <span className="chat-page-rail-item-text">
                {session.preview || session.date}
              </span>
              <span className="chat-page-rail-item-ws">{session.workspaceName}</span>
            </button>
          ))}
        </div>
      </div>
    )}

    {sessions.length === 0 && otherSessions.length === 0 && (
      <div className="chat-page-rail-empty">No previous chats yet.</div>
    )}
  </aside>
);
