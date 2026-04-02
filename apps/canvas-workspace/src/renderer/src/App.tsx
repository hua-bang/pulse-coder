import { useState } from 'react';
import { Canvas } from './components/Canvas';
import { Sidebar } from './components/Sidebar';
import { useWorkspaces } from './hooks/useWorkspaces';

const App = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(true);
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
        />
        <div className="canvas-viewport">
          {workspaces.map((ws) => (
            <Canvas key={ws.id} canvasId={ws.id} canvasName={ws.name} rootFolder={ws.rootFolder} hidden={ws.id !== activeId} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default App;
