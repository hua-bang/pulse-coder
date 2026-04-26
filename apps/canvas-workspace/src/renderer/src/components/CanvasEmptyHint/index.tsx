import { EMPTY_CANVAS_ACTIONS } from '../../constants/interaction';
import type { CanvasNode } from '../../types';
import './index.css';

interface CanvasEmptyHintProps {
  onCreateNode: (type: Extract<CanvasNode['type'], 'agent' | 'terminal' | 'file'>) => void;
  onOpenShortcuts: () => void;
}

export const CanvasEmptyHint = ({ onCreateNode, onOpenShortcuts }: CanvasEmptyHintProps) => (
  <div className="canvas-empty-hint">
    <div className="canvas-empty-card">
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
      <div className="hint-text">Start with a lightweight node</div>
      <div className="hint-sub">
        Create an Agent, Terminal, or Note to turn the blank canvas into a working session.
      </div>
      <div className="canvas-empty-actions">
        {EMPTY_CANVAS_ACTIONS.map((action) => (
          <button
            key={action.actionKey}
            type="button"
            className="canvas-empty-action"
            onClick={() => onCreateNode(action.nodeType)}
          >
            <span className="canvas-empty-action__label">{action.label}</span>
            <span className="canvas-empty-action__description">{action.description}</span>
          </button>
        ))}
      </div>
      <button type="button" className="canvas-empty-shortcuts" onClick={onOpenShortcuts}>
        <span className="canvas-empty-shortcuts__key">?</span>
        <span>Show keyboard shortcuts</span>
      </button>
    </div>
  </div>
);
