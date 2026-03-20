import { useState } from "react";
import { Canvas } from "./components/Canvas";
import { Sidebar } from "./components/Sidebar";

const App = () => {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  return (
    <div className="app">
      <div className="app-titlebar">
        <span className="titlebar-title">Canvas Workspace</span>
      </div>
      <div className="app-body">
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((c) => !c)}
        />
        <Canvas />
      </div>
    </div>
  );
};

export default App;
