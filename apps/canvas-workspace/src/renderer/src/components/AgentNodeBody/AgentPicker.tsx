import { AGENT_REGISTRY, type AgentDef } from '../../config/agentRegistry';
import { AgentIcon } from './AgentIcon';
import { truncatePath } from './utils/terminal';

interface AgentPickerProps {
  selectedAgent: string;
  cwdInput: string;
  promptInput: string;
  rootFolder?: string;
  recentCwds: string[];
  /** Optional Back button used when entering Setup from the Restart view. */
  onBack?: () => void;
  onAgentChange: (id: string) => void;
  onCwdChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onPickFolder: () => void;
  onLaunch: () => void;
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

const ChatGlyph = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path
      d="M2.5 4.5A1.5 1.5 0 014 3h8a1.5 1.5 0 011.5 1.5v5A1.5 1.5 0 0112 11H6.5L4 13.2V11A1.5 1.5 0 012.5 9.5v-5z"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinejoin="round"
    />
  </svg>
);

const PlayGlyph = () => (
  <svg width="11" height="11" viewBox="0 0 16 16" fill="none" aria-hidden="true">
    <path d="M4 3l9 5-9 5V3z" fill="currentColor" />
  </svg>
);

export const AgentPicker = ({
  selectedAgent,
  cwdInput,
  promptInput,
  rootFolder,
  recentCwds,
  onBack,
  onAgentChange,
  onCwdChange,
  onPromptChange,
  onPickFolder,
  onLaunch,
}: AgentPickerProps) => {
  const agentDef = AGENT_REGISTRY.find((a: AgentDef) => a.id === selectedAgent);
  const effectiveCwd = cwdInput || rootFolder || '';
  const previewCmd = agentDef?.command ?? 'agent';
  const visibleRecents = recentCwds.filter((p) => p !== cwdInput).slice(0, 3);
  const startTitle = `Start ${agentDef?.label ?? 'agent'}  —  ${previewCmd}${
    effectiveCwd ? ` in ${effectiveCwd}` : ''
  }`;

  return (
    <div className="agent-body-wrap agent-body-wrap--setup">
      <div className="agent-card">
        {onBack && (
          <div className="agent-card-back">
            <button
              type="button"
              className="agent-text-link"
              onClick={onBack}
              title="Back to saved configuration"
            >
              ← 返回
            </button>
          </div>
        )}

        <div className="agent-card-body">
          <div className="agent-tabs" role="tablist" aria-label="Coding agent">
            {AGENT_REGISTRY.map((a: AgentDef) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={selectedAgent === a.id}
                className={`agent-tab${
                  selectedAgent === a.id ? ' agent-tab--active' : ''
                }`}
                onClick={() => onAgentChange(a.id)}
                title={`${a.label} — ${a.description}`}
              >
                <AgentIcon id={a.id} size={16} />
                <span>{a.label}</span>
              </button>
            ))}
          </div>

          <div className="agent-field">
            <div className="agent-field-label">
              <FolderGlyph />
              <span>Working Directory</span>
            </div>
            <div className="agent-dir-field">
              <input
                type="text"
                className="agent-dir-input"
                value={cwdInput}
                onChange={(e) => onCwdChange(e.target.value)}
                placeholder={
                  rootFolder ? truncatePath(rootFolder, 36) : '/Users/jasper/project'
                }
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onLaunch();
                  }
                }}
              />
              <button
                type="button"
                className="agent-dir-icon"
                onClick={onPickFolder}
                title="Browse…"
                aria-label="Browse for folder"
              >
                <FolderGlyph />
              </button>
            </div>
            {visibleRecents.length > 0 && (
              <div className="agent-recent">
                <span className="agent-recent-label">Recent</span>
                {visibleRecents.map((p) => (
                  <button
                    key={p}
                    type="button"
                    className="agent-recent-chip"
                    onClick={() => onCwdChange(p)}
                    title={p}
                  >
                    {truncatePath(p, 22)}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="agent-field">
            <div className="agent-field-label">
              <ChatGlyph />
              <span>Initial Prompt</span>
            </div>
            <textarea
              className="agent-prompt-input"
              value={promptInput}
              onChange={(e) => onPromptChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  onLaunch();
                }
              }}
              placeholder="请输入初始提示..."
              spellCheck={false}
              rows={3}
            />
          </div>
        </div>

        <div className="agent-card-footer">
          <button
            type="button"
            className="agent-primary-btn"
            onClick={onLaunch}
            title={startTitle}
          >
            <PlayGlyph />
            初始化
          </button>
        </div>
      </div>
    </div>
  );
};
