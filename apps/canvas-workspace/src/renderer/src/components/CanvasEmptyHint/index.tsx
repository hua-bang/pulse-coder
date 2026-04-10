import './index.css';

export const CanvasEmptyHint = () => (
  <div className="canvas-empty-hint">
    <div className="hint-icon">
      <svg width="32" height="32" viewBox="0 0 512 512" fill="none" aria-hidden="true">
        <path
          d="M 80,268 H 188 L 228,178 L 260,370 L 292,148 L 328,268 H 432"
          stroke="currentColor"
          strokeWidth="22"
          strokeLinecap="round"
          strokeLinejoin="round"
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
