interface LayerContextMenuProps {
  x: number;
  y: number;
  nodeId: string;
  onFocus: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onClose: () => void;
}

export const LayerContextMenu = ({
  x,
  y,
  nodeId,
  onFocus,
  onDelete,
  onClose,
}: LayerContextMenuProps) => (
  <div
    className="sidebar-layer-context-menu"
    style={{ left: x, top: y }}
    onMouseDown={(e) => e.stopPropagation()}
    onContextMenu={(e) => e.preventDefault()}
  >
    <button
      className="sidebar-layer-context-menu-item"
      onClick={() => { onFocus(nodeId); onClose(); }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5" stroke="currentColor" strokeWidth="1.3" />
        <circle cx="8" cy="8" r="1.2" fill="currentColor" />
        <path d="M8 1.5v1.5M8 13v1.5M1.5 8h1.5M13 8h1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <span>Focus</span>
    </button>
    <div className="sidebar-layer-context-menu-separator" />
    <button
      className="sidebar-layer-context-menu-item sidebar-layer-context-menu-item--danger"
      onClick={() => { onDelete(nodeId); onClose(); }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path d="M3 4h10M6 4V2.5a1 1 0 011-1h2a1 1 0 011 1V4M5 4l.5 9a1 1 0 001 1h3a1 1 0 001-1L11 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      <span>Delete</span>
    </button>
  </div>
);
