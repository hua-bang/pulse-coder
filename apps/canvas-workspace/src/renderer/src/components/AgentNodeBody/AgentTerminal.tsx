import type React from 'react';

interface AgentTerminalProps {
  containerRef: React.RefObject<HTMLDivElement>;
  status: string;
  onRestart: () => void;
}

export const AgentTerminal = ({ containerRef, status, onRestart }: AgentTerminalProps) => (
  <div className="agent-body-wrap">
    <div
      ref={containerRef}
      className="agent-xterm-container"
      onMouseDown={(e) => e.stopPropagation()}
    />
    {(status === 'done' || status === 'error') && (
      <button
        type="button"
        className="agent-restart-btn"
        onClick={onRestart}
        title="Restart agent"
      >
        <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
          <path
            d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5H10.5"
            stroke="currentColor"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
        Restart
      </button>
    )}
  </div>
);
