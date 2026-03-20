import { useState } from "react";

interface Props {
  collapsed: boolean;
  onToggle: () => void;
}

const boards = [
  { id: "default", name: "Workspace", icon: "\u25A1" },
  { id: "scratch", name: "Scratch Pad", icon: "\u25CB" }
];

export const Sidebar = ({ collapsed, onToggle }: Props) => {
  const [activeId, setActiveId] = useState("default");

  return (
    <aside className={`sidebar${collapsed ? " sidebar--collapsed" : ""}`}>
      <div className="sidebar-header">
        {!collapsed && <span className="sidebar-brand">Canvas</span>}
        <button className="sidebar-toggle" onClick={onToggle} title="Toggle sidebar">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d={collapsed
                ? "M6 3l5 5-5 5"
                : "M10 3L5 8l5 5"}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {!collapsed && (
        <>
          <div className="sidebar-section-title">Whiteboards</div>
          <div className="sidebar-list">
            {boards.map((b) => (
              <button
                key={b.id}
                className={`sidebar-item${activeId === b.id ? " sidebar-item--active" : ""}`}
                onClick={() => setActiveId(b.id)}
              >
                <span className="sidebar-item-icon">{b.icon}</span>
                <span className="sidebar-item-name">{b.name}</span>
              </button>
            ))}
          </div>

          <div className="sidebar-section-title">Quick Actions</div>
          <div className="sidebar-list">
            <button className="sidebar-item sidebar-item--muted">
              <span className="sidebar-item-icon">+</span>
              <span className="sidebar-item-name">New Whiteboard</span>
            </button>
          </div>
        </>
      )}
    </aside>
  );
};
