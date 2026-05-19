import type React from 'react';
import { AGENT_REGISTRY } from '../../config/agentRegistry';
import { AgentIcon } from './AgentIcon';
import { truncatePath } from './utils/terminal';

interface AgentTerminalProps {
  containerRef: React.RefObject<HTMLDivElement>;
  status: string;
  agentType: string;
  cwd?: string;
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
}: AgentTerminalProps) => {
  const agentDef = AGENT_REGISTRY.find((a) => a.id === agentType);
  const statusInfo = STATUS_TEXT[status] ?? STATUS_TEXT.running;
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
      </div>
    </div>
  );
};
