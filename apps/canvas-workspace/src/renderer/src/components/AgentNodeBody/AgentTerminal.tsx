import type React from 'react';
import { AGENT_REGISTRY } from '../../config/agentRegistry';
import { AgentIcon } from './AgentIcon';
import { truncatePath } from './utils/terminal';

interface AgentTerminalProps {
  containerRef: React.RefObject<HTMLDivElement>;
  status: string;
  agentType: string;
  cwd?: string;
  onRestart: () => void;
  onStop?: () => void;
  onFocusTerminal?: () => void;
}

const FolderGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
      stroke="currentColor"
      strokeWidth="1.25"
    />
  </svg>
);

const StopGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <rect x="3.5" y="3.5" width="9" height="9" rx="1.3" stroke="currentColor" strokeWidth="1.4" />
  </svg>
);

const TerminalGlyph = () => (
  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M3 5l3 3-3 3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M8 11h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
  </svg>
);

const STATUS_TEXT: Record<string, { load: string; tone: 'running' | 'done' | 'error' }> = {
  running: { load: '已加载', tone: 'running' },
  done: { load: '已退出', tone: 'done' },
  error: { load: '出错', tone: 'error' },
  idle: { load: '空闲', tone: 'done' },
};

export const AgentTerminal = ({
  containerRef,
  status,
  agentType,
  cwd,
  onRestart,
  onStop,
  onFocusTerminal,
}: AgentTerminalProps) => {
  const agentDef = AGENT_REGISTRY.find((a) => a.id === agentType);
  const statusInfo = STATUS_TEXT[status] ?? STATUS_TEXT.running;
  const exited = status === 'done' || status === 'error';
  const displayCwd = cwd ? truncatePath(cwd, 32) : '—';

  return (
    <div className="agent-body-wrap agent-body-wrap--running">
      <div className="agent-card">
        <div className="agent-info-strip">
          <span className="agent-info-cell">
            <AgentIcon id={agentType} size={14} />
            <span className="agent-info-text">{agentDef?.label ?? agentType}</span>
          </span>
          <span className="agent-info-sep" aria-hidden="true" />
          <span className="agent-info-cell agent-info-cell--cwd" title={cwd ?? ''}>
            <FolderGlyph />
            <span className="agent-info-text agent-info-text--mono">{displayCwd}</span>
          </span>
          <span className="agent-info-sep" aria-hidden="true" />
          <span className={`agent-info-cell agent-info-load agent-info-load--${statusInfo.tone}`}>
            <span className="agent-info-load-dot" />
            {statusInfo.load}
          </span>
        </div>

        <div
          ref={containerRef}
          className="agent-xterm-container"
          onMouseDown={(e) => e.stopPropagation()}
        />

        <div className="agent-card-footer">
          {exited ? (
            <button
              type="button"
              className="agent-secondary-btn"
              onClick={onRestart}
              title="Restart agent"
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  d="M13 8a5 5 0 11-1.5-3.6M13 3v2.5H10.5"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              重启
            </button>
          ) : (
            <button
              type="button"
              className="agent-secondary-btn agent-secondary-btn--stop"
              onClick={onStop}
              title="Stop agent"
            >
              <StopGlyph />
              停止
            </button>
          )}
          <button
            type="button"
            className="agent-primary-btn"
            onClick={onFocusTerminal}
            title="Focus terminal"
          >
            <TerminalGlyph />
            打开终端
          </button>
        </div>
      </div>
    </div>
  );
};
