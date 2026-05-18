import type React from 'react';

interface AgentTerminalProps {
  containerRef: React.RefObject<HTMLDivElement>;
  status: string;
  lastExitCode?: number;
  /** When true, the agent CLI supports id-based resume — the session-end
   *  bar will offer a Continue/Retry primary action. Otherwise only the
   *  Start-fresh path is shown. */
  canResume?: boolean;
  onContinue: () => void;
  onNewSession: () => void;
  onCopyOutput?: () => void;
  onStop?: () => void;
  onSendPrompt?: (prompt: string) => void;
}

const CONTINUE_PROMPT = 'continue';
const SUMMARIZE_PROMPT = 'please summarize what you have done so far';

export const AgentTerminal = ({
  containerRef,
  status,
  lastExitCode,
  canResume = false,
  onContinue,
  onNewSession,
  onCopyOutput,
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
      <SessionEndBar
        status={status}
        exitCode={lastExitCode}
        canResume={canResume}
        onContinue={onContinue}
        onNewSession={onNewSession}
        onCopyOutput={onCopyOutput}
      />
    )}
  </div>
);

/**
 * Footer chrome shown after an agent exits. Replaces the old solitary
 * "Restart" button with a friendlier "the conversation is paused, here's
 * how to continue" presentation:
 *
 *   [● Done · exit 0]  [▸ Continue]   [↻ Start fresh]  [⎘ Copy]
 *
 * The primary action (Continue / Retry) is hidden when the agent doesn't
 * support id-based resume — in that case the user only sees the
 * Start-fresh and Copy escape hatches.
 */
interface SessionEndBarProps {
  status: 'done' | 'error' | string;
  exitCode?: number;
  canResume: boolean;
  onContinue: () => void;
  onNewSession: () => void;
  onCopyOutput?: () => void;
}

const SessionEndBar = ({
  status,
  exitCode,
  canResume,
  onContinue,
  onNewSession,
  onCopyOutput,
}: SessionEndBarProps) => {
  // `status === 'error'` covers spawn-failure cases (no exit code).
  // A non-zero `exitCode` covers normal-runtime failures. Either way
  // we want the badge / button to read as a recoverable error.
  const isError = status === 'error'
    || (typeof exitCode === 'number' && exitCode !== 0);
  const badgeLabel = isError
    ? `Error${typeof exitCode === 'number' ? ` · exit ${exitCode}` : ''}`
    : 'Done';
  const primaryLabel = isError ? 'Retry' : 'Continue';
  const primaryTitle = isError
    ? 'Retry — resume the conversation in a new shell'
    : 'Continue — resume the conversation in a new shell';

  return (
    <div className={`agent-session-end-bar${isError ? ' agent-session-end-bar--error' : ''}`}>
      <span className={`agent-session-badge${isError ? ' agent-session-badge--error' : ''}`}>
        <span className="agent-session-badge-dot" aria-hidden="true" />
        {badgeLabel}
      </span>
      {canResume && (
        <button
          type="button"
          className={`agent-session-primary${isError ? ' agent-session-primary--error' : ''}`}
          onClick={onContinue}
          title={primaryTitle}
        >
          {isError ? (
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
              <path
                d="M13 8a5 5 0 1 1-1.5-3.6M13 3v2.5H10.5"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
              <path d="M5 3l6 5-6 5V3z" fill="currentColor" />
            </svg>
          )}
          {primaryLabel}
        </button>
      )}
      <span className="agent-session-spacer" />
      <button
        type="button"
        className="agent-session-secondary"
        onClick={onNewSession}
        title="Start a brand-new conversation (clears the resume id)"
      >
        Start fresh
      </button>
      {onCopyOutput && (
        <button
          type="button"
          className="agent-session-secondary"
          onClick={onCopyOutput}
          title="Copy terminal output as plain text"
          aria-label="Copy output"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
            <rect x="5" y="2" width="9" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M3 5v8.5A1.5 1.5 0 0 0 4.5 15H11" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
};
