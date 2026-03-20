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
        />
        <Canvas canvasId={activeId} />
      </div>
    </div>
  );
};

export default App;
