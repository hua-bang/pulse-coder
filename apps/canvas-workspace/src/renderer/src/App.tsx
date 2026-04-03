import { useCallback, useState } from 'react';
import './App.css';
import { Canvas } from './components/Canvas';
import { Sidebar } from './components/Sidebar';
import { useWorkspaces } from './hooks/useWorkspaces';
import type { CanvasNode } from './types';

const App = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
  const [allNodes, setAllNodes] = useState<Record<string, CanvasNode[]>>({});
  const [focusNodeId, setFocusNodeId] = useState<string | undefined>();

  const handleNodesChange = useCallback((canvasId: string, nodes: CanvasNode[]) => {
    setAllNodes(prev => {
      if (prev[canvasId] === nodes) return prev;
      return { ...prev, [canvasId]: nodes };
    });
  }, []);

  const handleFocusComplete = useCallback(() => {
    setFocusNodeId(undefined);
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
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default App;
