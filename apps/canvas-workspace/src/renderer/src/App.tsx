import { useCallback, useState, useEffect, useRef } from 'react';
import { useLocation } from 'wouter';
import './App.css';
import { Canvas } from './components/Canvas';
import { ChatPage, ChatPanel } from './components/chat';
import { Sidebar } from './components/Sidebar';
import { useWorkspaces } from './hooks/useWorkspaces';
import type { CanvasNode } from './types';

const DEFAULT_CHAT_WIDTH = 420;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

const ROUTE_CANVAS = '/';
const ROUTE_CHAT = '/chat';

type ActiveView = 'canvas' | 'chat';

const App = () => {
  const [location, setLocation] = useLocation();
  const activeView: ActiveView = location === ROUTE_CHAT ? 'chat' : 'canvas';

  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [chatPanelOpen, setChatPanelOpen] = useState(false);
  const [chatWidth, setChatWidth] = useState(DEFAULT_CHAT_WIDTH);
  const [allNodes, setAllNodes] = useState<Record<string, CanvasNode[]>>({});
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>();
  const [deleteNodeId, setDeleteNodeId] = useState<string | undefined>();
  const resizing = useRef(false);

  const handleNodesChange = useCallback((canvasId: string, nodes: CanvasNode[]) => {
    setAllNodes(prev => {
      if (prev[canvasId] === nodes) return prev;
      return { ...prev, [canvasId]: nodes };
    });
  }, []);

  const handleFocusComplete = useCallback(() => {
    setFocusNodeId(undefined);
  }, []);
  const handleDeleteComplete = useCallback(() => {
    setDeleteNodeId(undefined);
  }, []);
  const {
    workspaces,
    folders,
    activeId,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setRootFolder,
    createFolder,
    renameFolder,
    deleteFolder,
    toggleFolder,
    moveWorkspace,
    reorderFolder,
  } = useWorkspaces();

  const enterChatView = useCallback(() => {
    // When entering the full-screen page, also close the right-side panel so
    // only one ChatView instance (and one set of IPC subscriptions) is live.
    setChatPanelOpen(false);
    setLocation(ROUTE_CHAT);
  }, [setLocation]);

  const exitChatView = useCallback(() => {
    setLocation(ROUTE_CANVAS);
  }, [setLocation]);

  // Selecting a workspace from the sidebar also routes back to the canvas.
  // This is the only Canvas affordance in the expanded sidebar (the explicit
  // Canvas nav entry was intentionally removed).
  const handleSelectWorkspace = useCallback((id: string) => {
    selectWorkspace(id);
    setLocation(ROUTE_CANVAS);
  }, [selectWorkspace, setLocation]);

  // Keyboard shortcuts:
  //   Cmd/Ctrl+Shift+A → toggle right-side chat panel (canvas view only)
  //   Cmd/Ctrl+Shift+L → toggle full-screen chat page
  //   Esc (while on chat page) → return to canvas
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        if (activeView !== 'canvas') return;
        e.preventDefault();
        setChatPanelOpen(prev => !prev);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        if (activeView === 'chat') {
          setLocation(ROUTE_CANVAS);
        } else {
          setChatPanelOpen(false);
          setLocation(ROUTE_CHAT);
        }
        return;
      }
      if (e.key === 'Escape' && activeView === 'chat') {
        // Don't swallow Esc if the user is typing in a text field (mention popup, etc.)
        const target = e.target as HTMLElement | null;
        const tag = target?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target?.isContentEditable) return;
        setLocation(ROUTE_CANVAS);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeView, setLocation]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizing.current = true;
    const startX = e.clientX;
    const startWidth = chatWidth;

    const onMouseMove = (ev: MouseEvent) => {
      const delta = startX - ev.clientX;
      const newWidth = Math.min(MAX_CHAT_WIDTH, Math.max(MIN_CHAT_WIDTH, startWidth + delta));
      setChatWidth(newWidth);
    };

    const onMouseUp = () => {
      resizing.current = false;
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [chatWidth]);

  // Jumping to a node from the chat page: focus it AND return to canvas.
  const handleNodeFocusFromChatPage = useCallback((nodeId: string) => {
    setFocusNodeId(nodeId);
    setLocation(ROUTE_CANVAS);
  }, [setLocation]);

  const activeWorkspace = workspaces.find((ws) => ws.id === activeId);

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
          workspaces={workspaces}
          folders={folders}
          activeId={activeId}
          onSelect={handleSelectWorkspace}
          onCreate={createWorkspace}
          onRename={renameWorkspace}
          onDelete={deleteWorkspace}
          onSetRootFolder={setRootFolder}
          onCreateFolder={createFolder}
          onRenameFolder={renameFolder}
          onDeleteFolder={deleteFolder}
          onToggleFolder={toggleFolder}
          onMoveWorkspace={moveWorkspace}
          onReorderFolder={reorderFolder}
          activeNodes={allNodes[activeId] || []}
          onNodeFocus={setFocusNodeId}
          onNodeDelete={setDeleteNodeId}
          activeView={activeView}
          onEnterChat={enterChatView}
          onExitChat={exitChatView}
        />
        {activeView === 'canvas' && (
          <>
            <div className="canvas-viewport">
              {workspaces.map((ws) => (
                <Canvas
                  key={ws.id}
                  canvasId={ws.id}
                  canvasName={ws.name}
                  rootFolder={ws.rootFolder}
                  hidden={ws.id !== activeId}
                  onNodesChange={handleNodesChange}
                  focusNodeId={ws.id === activeId ? focusNodeId : undefined}
                  onFocusComplete={handleFocusComplete}
                  deleteNodeId={ws.id === activeId ? deleteNodeId : undefined}
                  onDeleteComplete={handleDeleteComplete}
                  chatPanelOpen={chatPanelOpen}
                  onChatToggle={() => setChatPanelOpen(prev => !prev)}
                />
              ))}
            </div>
            {workspaces.map((ws) => (
              <div
                key={ws.id}
                className={`chat-panel-wrapper${chatPanelOpen && ws.id === activeId ? ' chat-panel-wrapper--open' : ''}`}
                style={ws.id !== activeId ? { display: 'none' } : chatPanelOpen ? { width: chatWidth } : undefined}
              >
                <ChatPanel
                  workspaceId={ws.id}
                  allWorkspaces={workspaces}
                  nodes={allNodes[ws.id] || []}
                  rootFolder={ws.rootFolder}
                  onClose={() => setChatPanelOpen(false)}
                  onResizeStart={handleResizeStart}
                  onNodeFocus={setFocusNodeId}
                  onExpand={enterChatView}
                />
              </div>
            ))}
          </>
        )}
        {activeView === 'chat' && (
          <ChatPage
            initialWorkspaceId={activeId}
            allWorkspaces={workspaces}
            nodes={allNodes[activeId] || []}
            rootFolder={activeWorkspace?.rootFolder}
            onExit={exitChatView}
            onNodeFocus={handleNodeFocusFromChatPage}
          />
        )}
      </div>
    </div>
  );
};

export default App;
