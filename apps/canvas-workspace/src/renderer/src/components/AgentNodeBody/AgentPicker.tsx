import { useEffect, useRef, useState } from 'react';
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
  const agentLabel = agentDef?.label ?? 'agent';
  const startTitle = `Start ${agentLabel}  \u2014  ${previewCmd}${
    effectiveCwd ? ` in ${effectiveCwd}` : ''
  }`;
  const pathDisplay = effectiveCwd
    ? truncatePath(effectiveCwd, 34)
    : 'Choose folder';

  const [agentMenuOpen, setAgentMenuOpen] = useState(false);
  const [pathMenuOpen, setPathMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentMenuOpen && !pathMenuOpen) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) {
        setAgentMenuOpen(false);
        setPathMenuOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setAgentMenuOpen(false);
        setPathMenuOpen(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [agentMenuOpen, pathMenuOpen]);

  const pickAgent = (id: string) => {
    onAgentChange(id);
    setAgentMenuOpen(false);
  };

  const pickRecent = (p: string) => {
    onCwdChange(p);
    setPathMenuOpen(false);
  };

  return (
    <div className="agent-body-wrap" ref={rootRef}>
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
            placeholder={`Ask ${agentLabel} to\u2026`}
            spellCheck={false}
            autoFocus
          />

          <div className="agent-launcher-toolbar">
            <div className="agent-dropdown">
              <button
                type="button"
                className={`agent-dropdown-trigger${
                  agentMenuOpen ? ' is-open' : ''
                }`}
                onClick={() => {
                  setPathMenuOpen(false);
                  setAgentMenuOpen((v) => !v);
                }}
                aria-haspopup="listbox"
                aria-expanded={agentMenuOpen}
                title={`${agentLabel} \u2014 ${previewCmd}`}
              >
                <AgentIcon id={selectedAgent} />
                <span>{agentLabel}</span>
                <svg
                  className="agent-caret"
                  width="8"
                  height="8"
                  viewBox="0 0 10 10"
                  fill="none"
                >
                  <path
                    d="M2.5 4l2.5 2.5L7.5 4"
                    stroke="currentColor"
                    strokeWidth="1.3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {agentMenuOpen && (
                <div className="agent-popover agent-popover--left" role="listbox">
                  {AGENT_REGISTRY.map((a: AgentDef) => (
                    <button
                      key={a.id}
                      type="button"
                      role="option"
                      aria-selected={selectedAgent === a.id}
                      className={`agent-popover-item${
                        selectedAgent === a.id ? ' is-active' : ''
                      }`}
                      onClick={() => pickAgent(a.id)}
                    >
                      <span className="agent-popover-icon">
                        <AgentIcon id={a.id} />
                      </span>
                      <span className="agent-popover-label">
                        <strong>{a.label}</strong>
                        <small>{a.description}</small>
                      </span>
                      {selectedAgent === a.id && (
                        <svg
                          width="12"
                          height="12"
                          viewBox="0 0 12 12"
                          fill="none"
                          className="agent-popover-check"
                        >
                          <path
                            d="M2.5 6.2l2.4 2.4L9.5 3.5"
                            stroke="currentColor"
                            strokeWidth="1.5"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />
                        </svg>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>

            <div className="agent-path">
              <button
                type="button"
                className={`agent-path-chip${
                  pathMenuOpen ? ' is-open' : ''
                }${effectiveCwd ? '' : ' is-empty'}`}
                onClick={() => {
                  setAgentMenuOpen(false);
                  setPathMenuOpen((v) => !v);
                }}
                aria-haspopup="dialog"
                aria-expanded={pathMenuOpen}
                title={effectiveCwd || 'Choose a working directory'}
              >
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                    stroke="currentColor"
                    strokeWidth="1.2"
                  />
                </svg>
                <span className="agent-path-text">{pathDisplay}</span>
              </button>
              {pathMenuOpen && (
                <div className="agent-popover agent-popover--center" role="dialog">
                  <input
                    type="text"
                    className="agent-popover-input"
                    value={cwdInput}
                    autoFocus
                    onChange={(e) => onCwdChange(e.target.value)}
                    placeholder={rootFolder || 'Working directory'}
                    spellCheck={false}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        setPathMenuOpen(false);
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="agent-popover-action"
                    onClick={() => {
                      setPathMenuOpen(false);
                      onPickFolder();
                    }}
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z"
                        stroke="currentColor"
                        strokeWidth="1.2"
                      />
                    </svg>
                    {'Browse\u2026'}
                  </button>
                  {recentCwds.length > 0 && (
                    <>
                      <div className="agent-popover-divider" />
                      <div className="agent-popover-section">Recent</div>
                      {recentCwds.slice(0, 4).map((p) => (
                        <button
                          key={p}
                          type="button"
                          className={`agent-popover-recent${
                            p === effectiveCwd ? ' is-active' : ''
                          }`}
                          onClick={() => pickRecent(p)}
                          title={p}
                        >
                          {truncatePath(p, 38)}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            <button
              type="button"
              className="agent-launch-btn"
              onClick={onLaunch}
              title={startTitle}
              aria-label={startTitle}
            >
              <svg width="11" height="11" viewBox="0 0 16 16" fill="none">
                <path d="M4 3l9 5-9 5V3z" fill="currentColor" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
