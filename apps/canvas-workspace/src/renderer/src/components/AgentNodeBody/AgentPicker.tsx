import { AGENT_REGISTRY, type AgentDef } from '../../config/agentRegistry';
import { AgentIcon } from './AgentIcon';
import { truncatePath } from './utils/terminal';

interface AgentPickerProps {
  selectedAgent: string;
  cwdInput: string;
  promptInput: string;
  rootFolder?: string;
  recentCwds: string[];
  onAgentChange: (id: string) => void;
  onCwdChange: (value: string) => void;
  onPromptChange: (value: string) => void;
  onPickFolder: () => void;
  onLaunch: () => void;
}

export const AgentPicker = ({
  selectedAgent,
  cwdInput,
  promptInput,
  rootFolder,
  recentCwds,
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
  const startTitle = `Start ${agentDef?.label ?? 'agent'}  \u2014  ${previewCmd}${
    effectiveCwd ? ` in ${effectiveCwd}` : ''
  }`;

  return (
    <div className="agent-body-wrap">
      <div className="agent-picker">
        <div className="agent-launcher-card">
          <textarea
            className="agent-launcher-prompt"
            value={promptInput}
            onChange={(e) => onPromptChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onLaunch();
              }
            }}
            placeholder={'What should the agent do?'}
            spellCheck={false}
            autoFocus
          />

          <div className="agent-launcher-toolbar">
            <div
              className="agent-pills"
              role="tablist"
              aria-label="Agent"
            >
              {AGENT_REGISTRY.map((a: AgentDef) => (
                <button
                  key={a.id}
                  type="button"
                  role="tab"
                  aria-selected={selectedAgent === a.id}
                  className={`agent-pill${
                    selectedAgent === a.id ? ' agent-pill--active' : ''
                  }`}
                  onClick={() => onAgentChange(a.id)}
                  title={`${a.label} \u2014 ${a.description}`}
                >
                  <AgentIcon id={a.id} />
                  <span>{a.label}</span>
                </button>
              ))}
            </div>

            <div className="agent-toolbar-row">
              <div className="agent-dir-field">
                <button
                  type="button"
                  className="agent-dir-icon"
                  onClick={onPickFolder}
                  title={'Browse\u2026'}
                  aria-label="Browse for folder"
                >
                  <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
                    <path
                      d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                      stroke="currentColor"
                      strokeWidth="1.2"
                    />
                  </svg>
                </button>
                <input
                  type="text"
                  className="agent-dir-input"
                  value={cwdInput}
                  onChange={(e) => onCwdChange(e.target.value)}
                  placeholder={
                    rootFolder
                      ? truncatePath(rootFolder, 32)
                      : 'Working directory'
                  }
                  spellCheck={false}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      onLaunch();
                    }
                  }}
                />
              </div>

              <button
                type="button"
                className="agent-launch-btn"
                onClick={onLaunch}
                title={startTitle}
              >
                <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                  <path d="M4 3l9 5-9 5V3z" fill="currentColor" />
                </svg>
                Start
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
        </div>
      </div>
    </div>
  );
};
