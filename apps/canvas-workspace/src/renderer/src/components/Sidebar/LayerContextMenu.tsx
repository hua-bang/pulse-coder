interface LayerContextMenuProps {
  x: number;
  y: number;
  nodeId: string;
  onFocus: (nodeId: string) => void;
  onRename: (nodeId: string) => void;
  onDelete: (nodeId: string) => void;
  onCopyLink: (nodeId: string) => void;
  onClose: () => void;
}

export const LayerContextMenu = ({
  x,
  y,
  nodeId,
  onFocus,
  onRename,
  onDelete,
  onCopyLink,
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
    <button
      className="sidebar-layer-context-menu-item"
      onClick={() => { onRename(nodeId); onClose(); }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path d="M3.5 12.5h2.8L12.6 6.2 9.8 3.4 3.5 9.7v2.8z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
        <path d="M8.9 4.3l2.8 2.8" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <span>Rename</span>
    </button>
    <button
      className="sidebar-layer-context-menu-item"
      onClick={() => { onCopyLink(nodeId); onClose(); }}
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path d="M6.2 9.8L9.8 6.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
        <path d="M6.3 12.4H4.9a2.9 2.9 0 010-5.8h1.5M9.7 3.6h1.4a2.9 2.9 0 110 5.8H9.6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
      </svg>
      <span>Copy link</span>
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
