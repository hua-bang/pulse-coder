import type React from 'react';

interface AgentTerminalProps {
  containerRef: React.RefObject<HTMLDivElement>;
  status: string;
  lastExitCode?: number;
  /** When true, the agent CLI supports id-based resume — the session-end
   *  bar will offer a Continue/Retry primary action. Otherwise the user
   *  only sees a status badge and Copy. */
  canResume?: boolean;
  onContinue: () => void;
  onCopyOutput?: () => void;
}

export const AgentTerminal = ({
  containerRef,
  status,
  lastExitCode,
  canResume = false,
  onContinue,
  onCopyOutput,
}: AgentTerminalProps) => (
  <div className="agent-body-wrap">
    <div
      ref={containerRef}
      className="agent-xterm-container"
      onMouseDown={(e) => e.stopPropagation()}
    />
    {(status === 'done' || status === 'error') && (
      <SessionEndBar
        status={status}
        exitCode={lastExitCode}
        canResume={canResume}
        onContinue={onContinue}
        onCopyOutput={onCopyOutput}
      />
    )}
  </div>
);

/**
 * Footer chrome shown after an agent exits. Surfaces:
 *
 *   [● Done · exit 0]  [▸ Continue]                          [⎘ Copy]
 *
 * Continue / Retry is the only path back into the conversation — the
 * explicit "Restart / Start fresh" affordance was removed entirely so
 * users never have to reason about throwing away the agent state. To
 * truly start over they close the node and create a new one, which is
 * the same mental model as "this conversation is finished, open a new
 * one". For agents that don't support id-based resume, the Continue
 * button is hidden and the bar only shows status + Copy.
 *
 * Running-state chrome (the old quick-actions bar with Continue /
 * Summarize / Stop) was removed for similar reasons: in-flight
 * Continue/Summarize prompts fought with the agent's own turn, and
 * Stop overlapped with the agent's `esc to interrupt` plus the
 * node-close button.
 */
interface SessionEndBarProps {
  status: 'done' | 'error' | string;
  exitCode?: number;
  canResume: boolean;
  onContinue: () => void;
  onCopyOutput?: () => void;
}

const SessionEndBar = ({
  status,
  exitCode,
  canResume,
  onContinue,
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
