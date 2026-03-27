export const CanvasEmptyHint = () => (
  <div className="canvas-empty-hint">
    <div className="hint-icon">
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <rect
          x="4"
          y="4"
          width="16"
          height="16"
          rx="3"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M10 12h4M12 10v4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    </div>
    <div className="hint-text">
      Right-click or double-click to add a card
    </div>
    <div className="hint-sub">
      Scroll to pan &middot; Ctrl+Scroll to zoom
    </div>
  </div>
);
