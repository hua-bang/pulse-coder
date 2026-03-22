import { useState } from 'react';
import { Canvas } from './components/Canvas';
import { Sidebar } from './components/Sidebar';
import { useWorkspaces } from './hooks/useWorkspaces';

const App = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const {
    workspaces,
    activeId,
    selectWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    setRootFolder,
  } = useWorkspaces();

  return (
    <div className="app">
      <div className="app-titlebar">
        <span className="titlebar-title">Canvas Workspace</span>
      </div>
      <div className="app-body">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
          workspaces={workspaces}
          activeId={activeId}
          onSelect={selectWorkspace}
          onCreate={createWorkspace}
          onRename={renameWorkspace}
          onDelete={deleteWorkspace}
          onSetRootFolder={setRootFolder}
        />
        <div className="canvas-viewport">
          {workspaces.map((ws) => (
            <Canvas key={ws.id} canvasId={ws.id} rootFolder={ws.rootFolder} hidden={ws.id !== activeId} />
          ))}
        </div>
      </div>
    </div>
  );
};

export default App;
