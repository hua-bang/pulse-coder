import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentChatMessage, AgentSessionInfo } from '../../../types';
import type { OtherWorkspaceSession, WorkspaceOption } from '../types';

interface UseChatSessionsOptions {
  workspaceId: string;
  allWorkspaces?: WorkspaceOption[];
  onMessagesLoaded: (messages: AgentChatMessage[]) => void;
  /** When true, load the session list on mount and whenever workspaceId changes. */
  eagerLoad?: boolean;
  /**
   * When true, don't call getHistory on mount. Use this when the caller is
   * about to load a specific session manually — avoids a race between the
   * initial getHistory and the pending loadSession.
   */
  skipInitialHistory?: boolean;
}

export function useChatSessions({
  workspaceId,
  allWorkspaces,
  onMessagesLoaded,
  eagerLoad = false,
  skipInitialHistory = false,
}: UseChatSessionsOptions) {
  const [sessionMenuOpen, setSessionMenuOpen] = useState(false);
  const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
  const [otherSessions, setOtherSessions] = useState<OtherWorkspaceSession[]>([]);
  const sessionMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (skipInitialHistory) return;
    void (async () => {
      const result = await window.canvasWorkspace.agent.getHistory(workspaceId);
      if (result.ok && result.messages) {
        onMessagesLoaded(result.messages);
      }
    })();
  }, [workspaceId, onMessagesLoaded, skipInitialHistory]);

  useEffect(() => {
    if (!sessionMenuOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      if (sessionMenuRef.current && !sessionMenuRef.current.contains(event.target as Node)) {
        setSessionMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [sessionMenuOpen]);

  const loadSessions = useCallback(async () => {
    const result = await window.canvasWorkspace.agent.listSessions(workspaceId);
    if (result.ok && result.sessions) {
      setSessions(result.sessions);
    }

    if (allWorkspaces && allWorkspaces.length > 1) {
      const workspaceNameMap: Record<string, string> = {};
      for (const workspace of allWorkspaces) {
        workspaceNameMap[workspace.id] = workspace.name;
      }

      const allResult = await window.canvasWorkspace.agent.listAllSessions(workspaceNameMap);
      if (allResult.ok && allResult.groups) {
        const flattened: OtherWorkspaceSession[] = [];
        for (const group of allResult.groups) {
          if (group.workspaceId === workspaceId) continue;
          for (const session of group.sessions) {
            flattened.push({
              ...session,
              sourceWorkspaceId: group.workspaceId,
              workspaceName: group.workspaceName,
            });
          }
        }

        flattened.sort((left, right) => right.date.localeCompare(left.date));
        setOtherSessions(flattened);
      }
    } else {
      setOtherSessions([]);
    }
  }, [allWorkspaces, workspaceId]);

  useEffect(() => {
    if (!eagerLoad) return;
    void loadSessions();
  }, [eagerLoad, loadSessions]);

  const openSessionMenu = useCallback(async () => {
    if (sessionMenuOpen) {
      setSessionMenuOpen(false);
      return;
    }

    await loadSessions();
    setSessionMenuOpen(true);
  }, [loadSessions, sessionMenuOpen]);

  const handleNewSession = useCallback(async () => {
    setSessionMenuOpen(false);
    await window.canvasWorkspace.agent.newSession(workspaceId);
    onMessagesLoaded([]);
  }, [onMessagesLoaded, workspaceId]);

  const handleLoadSession = useCallback(async (sessionId: string, sourceWorkspaceId?: string) => {
    setSessionMenuOpen(false);

    const result = sourceWorkspaceId && sourceWorkspaceId !== workspaceId
      ? await window.canvasWorkspace.agent.loadCrossWorkspaceSession(workspaceId, sourceWorkspaceId, sessionId)
      : await window.canvasWorkspace.agent.loadSession(workspaceId, sessionId);

    if (result.ok && result.messages) {
      onMessagesLoaded(result.messages);
    }
  }, [onMessagesLoaded, workspaceId]);

  return {
    otherSessions,
    handleLoadSession,
    handleNewSession,
    loadSessions,
    openSessionMenu,
    sessionMenuOpen,
    sessionMenuRef,
    sessions,
  };
}
