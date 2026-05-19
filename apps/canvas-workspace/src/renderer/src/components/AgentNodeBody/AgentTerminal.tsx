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
 *   [● Ended]  [▸ Continue]                                   [⎘ Copy]
 *
 * Continue is the only path back into the conversation — the explicit
 * "Restart / Start fresh" affordance was removed entirely so users
 * never reason about throwing away agent state. To truly start over,
 * close the node and create a new one. For agents that don't support
 * id-based resume the Continue button is hidden and the bar only shows
 * status + Copy.
 *
 * Visual is deliberately monochrome: spawn failures, non-zero exits,
 * and clean exits all render the same neutral "Ended" pill. Exit-code
 * details surface only on hover so they don't dominate the canvas at
 * a glance — what matters for the user is "session is over, pick up
 * if you want", not the exit-code post-mortem.
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
  let detailTitle = 'Session ended';
  if (status === 'error') {
    detailTitle = 'Session failed to start';
  } else if (typeof exitCode === 'number' && exitCode !== 0) {
    detailTitle = `Session ended · exit ${exitCode}`;
  }

  return (
    <div className="agent-session-end-bar">
      <span className="agent-session-badge" title={detailTitle}>
        <span className="agent-session-badge-dot" aria-hidden="true" />
        Ended
      </span>
      {canResume && (
        <button
          type="button"
          className="agent-session-primary"
          onClick={onContinue}
          title="Continue — resume the conversation in a new shell"
        >
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
            <path d="M5 3l6 5-6 5V3z" fill="currentColor" />
          </svg>
          Continue
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
