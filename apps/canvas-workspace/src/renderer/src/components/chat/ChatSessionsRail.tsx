import { ListLinesIcon, PlusIcon } from '../icons';

export interface UnifiedSession {
  sessionId: string;
  workspaceId: string;
  workspaceName: string;
  date: string;
  messageCount: number;
  preview?: string;
  isCurrent?: boolean;
}

interface ChatSessionsRailProps {
  allSessions: UnifiedSession[];
  onNewSession: () => void | Promise<void>;
  onSelectSession: (session: UnifiedSession) => void;
}

/**
 * Always-visible sessions rail for ChatPage. Shows a single unified list of
 * sessions from all workspaces — the chat page does not have a "selected
 * workspace" concept, each session carries its own workspace as metadata.
 *
 * Layout: "New chat" stays pinned at the top while the session list scrolls.
 */
export const ChatSessionsRail = ({
  allSessions,
  onNewSession,
  onSelectSession,
}: ChatSessionsRailProps) => (
  <aside className="chat-page-rail">
    <button
      className="chat-page-rail-new"
      onClick={() => void onNewSession()}
    >
      <PlusIcon size={14} strokeWidth={1.3} />
      <span>New chat</span>
    </button>

    <div className="chat-page-rail-scroll">
      {allSessions.length === 0 ? (
        <div className="chat-page-rail-empty">No previous chats yet.</div>
      ) : (
        <div className="chat-page-rail-list">
          {allSessions.map((session) => (
            <button
              key={`${session.workspaceId}:${session.sessionId}`}
              className={`chat-page-rail-item${session.isCurrent ? ' chat-page-rail-item--active' : ''}`}
              onClick={() => onSelectSession(session)}
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
      )}
    </div>
  </aside>
);
