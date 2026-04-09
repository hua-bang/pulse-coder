import { useCallback, useState, useEffect, useRef } from 'react';
import './App.css';
import { Canvas } from './components/Canvas';
import { ChatPanel } from './components/ChatPanel';
import { Sidebar } from './components/Sidebar';
import { useWorkspaces } from './hooks/useWorkspaces';
import type { CanvasNode } from './types';

const DEFAULT_CHAT_WIDTH = 380;
const MIN_CHAT_WIDTH = 280;
const MAX_CHAT_WIDTH = 600;

const App = () => {
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

  // Keyboard shortcut: Cmd/Ctrl+Shift+A to toggle chat panel
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        setChatPanelOpen(prev => !prev);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

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

  return (
    <div className="app">
      <div className="app-body">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
          workspaces={workspaces}
          folders={folders}
          activeId={activeId}
          onSelect={selectWorkspace}
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
        />
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
        {activeId && (
          <div
            className={`chat-panel-wrapper${chatPanelOpen ? ' chat-panel-wrapper--open' : ''}`}
            style={chatPanelOpen ? { width: chatWidth } : undefined}
          >
            <ChatPanel
              workspaceId={activeId}
              nodes={allNodes[activeId] || []}
              rootFolder={workspaces.find(w => w.id === activeId)?.rootFolder}
              onClose={() => setChatPanelOpen(false)}
              onResizeStart={handleResizeStart}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default App;
