import { useState } from 'react';
import { AGENT_REGISTRY } from '../../config/agentRegistry';
import { AgentIcon } from './AgentIcon';
import { truncatePath } from './utils/terminal';

interface AgentRestartProps {
  agentType: string;
  cwd?: string;
  prompt?: string;
  scrollback?: string;
  onRestart: () => void;
  onEdit: () => void;
}

const FolderGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
      stroke="currentColor"
      strokeWidth="1.3"
    />
  </svg>
);

const ChatGlyph = () => (
  <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M2.5 4.5A1.5 1.5 0 014 3h8a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 11H6.5L4 13.2V11A1.5 1.5 0 012.5 9.5v-5z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

const CheckGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.2" />
    <path
      d="M5 8.2l2.1 2L11 6.5"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const WarningGlyph = () => (
  <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M7.1 2.5L1.5 12.5A1 1 0 002.4 14h11.2a1 1 0 00.9-1.5L8.9 2.5a1 1 0 00-1.8 0z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
    <path d="M8 6v3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    <circle cx="8" cy="11.5" r="0.7" fill="currentColor" />
  </svg>
);

const PlayGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 3l9 5-9 5V3z" fill="currentColor" />
  </svg>
);

const PencilGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M11 2.5l2.5 2.5L5 13.5H2.5V11L11 2.5z"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinejoin="round"
    />
  </svg>
);

const tailLines = (text: string, count = 12): string =>
  text.split('\n').slice(-count).join('\n').replace(/^\s+|\s+$/g, '');

export const AgentRestart = ({
  agentType,
  cwd,
  prompt,
  scrollback,
  onRestart,
  onEdit,
}: AgentRestartProps) => {
  const [showDetails, setShowDetails] = useState(false);
  const agentDef = AGENT_REGISTRY.find((a) => a.id === agentType);
  const cwdDisplay = cwd ? truncatePath(cwd, 36) : 'Working Directory';
  const hasPrompt = !!(prompt && prompt.trim().length > 0);
  const promptPreview = hasPrompt ? '已保存' : '未提供';

  return (
    <div className="agent-body-wrap agent-body-wrap--restart">
      <div className="agent-card">
        <div className="agent-card-body">
          <div className="agent-section-title">已保存的配置</div>

          <div className="agent-saved-list">
            <div className="agent-saved-row" title={agentDef?.label ?? agentType}>
              <span className="agent-saved-row-left">
                <AgentIcon id={agentType} size={16} />
                <span className="agent-saved-row-label">
                  {agentDef?.label ?? 'Coding Agent'}
                </span>
              </span>
              <span className="agent-saved-row-check"><CheckGlyph /></span>
            </div>

            <div className="agent-saved-row" title={cwd ?? ''}>
              <span className="agent-saved-row-left">
                <FolderGlyph />
                <span className="agent-saved-row-label agent-saved-row-label--mono">
                  {cwdDisplay}
                </span>
              </span>
              <span className="agent-saved-row-check"><CheckGlyph /></span>
            </div>

            <div className="agent-saved-row" title={prompt ?? ''}>
              <span className="agent-saved-row-left">
                <ChatGlyph />
                <span className="agent-saved-row-label">Initial Prompt</span>
              </span>
              <span className="agent-saved-row-meta">{promptPreview}</span>
            </div>
          </div>

          <div className="agent-warning">
            <span className="agent-warning-icon"><WarningGlyph /></span>
            <span className="agent-warning-text">应用重启后，CLI 运行状态已丢失。</span>
          </div>
        </div>

        <div className="agent-card-footer agent-card-footer--restart">
          <button
            type="button"
            className="agent-primary-btn"
            onClick={onRestart}
            title="Restart with saved configuration"
          >
            <PlayGlyph />
            重新启动会话
          </button>
          <button
            type="button"
            className="agent-secondary-btn"
            onClick={onEdit}
            title="Edit initial parameters"
          >
            <PencilGlyph />
            编辑初始化参数
          </button>
        </div>

        <button
          type="button"
          className="agent-text-link agent-text-link--center"
          onClick={() => setShowDetails((v) => !v)}
          title="View last configuration"
        >
          {showDetails ? '收起' : '查看上次配置'}
        </button>

        {showDetails && (
          <div className="agent-details">
            {hasPrompt && (
              <div className="agent-details-block">
                <div className="agent-details-label">Initial Prompt</div>
                <pre className="agent-details-content">{prompt}</pre>
              </div>
            )}
            {scrollback && scrollback.trim().length > 0 && (
              <div className="agent-details-block">
                <div className="agent-details-label">Last Output</div>
                <pre className="agent-details-content agent-details-content--scrollback">
                  {tailLines(scrollback)}
                </pre>
              </div>
            )}
            {!hasPrompt && (!scrollback || !scrollback.trim()) && (
              <div className="agent-details-empty">无更多保存信息。</div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
