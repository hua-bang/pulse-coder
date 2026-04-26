import type React from 'react';

interface AgentTerminalProps {
  containerRef: React.RefObject<HTMLDivElement>;
  status: string;
  onRestart: () => void;
  onStop?: () => void;
  onSendPrompt?: (prompt: string) => void;
}

const CONTINUE_PROMPT = 'continue';
const SUMMARIZE_PROMPT = 'please summarize what you have done so far';

export const AgentTerminal = ({
  containerRef,
  status,
  onRestart,
  onStop,
  onSendPrompt,
}: AgentTerminalProps) => (
  <div className="agent-body-wrap">
    <div
      ref={containerRef}
      className="agent-xterm-container"
      onMouseDown={(e) => e.stopPropagation()}
    />
    {status === 'running' && (
      <div className="agent-quick-actions">
        <button
          type="button"
          className="agent-quick-btn"
          onClick={() => onSendPrompt?.(CONTINUE_PROMPT)}
          title="Send 'continue' to agent"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M5 3l6 5-6 5V3z" fill="currentColor" />
          </svg>
          Continue
        </button>
        <button
          type="button"
          className="agent-quick-btn"
          onClick={() => onSendPrompt?.(SUMMARIZE_PROMPT)}
          title="Ask agent to summarize"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M3 4h10M3 7.5h7M3 11h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
          </svg>
          Summarize
        </button>
        <button
          type="button"
          className="agent-quick-btn agent-quick-btn--stop"
          onClick={onStop}
          title="Stop agent"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="3" width="10" height="10" rx="1.5" fill="currentColor" />
          </svg>
          Stop
        </button>
      </div>
    )}
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
