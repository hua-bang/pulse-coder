import "./index.css";
import { useEffect, useRef, useState } from "react";

const AGENT_OPTIONS = [
  { type: 'codex', label: 'Codex', command: 'codex' },
  { type: 'claude-code', label: 'Claude Code', command: 'claude' },
  { type: 'pulse-coder', label: 'Pulse Coder', command: 'pulse-coder' },
];

interface Props {
  x: number;
  y: number;
  onCreate: (type: "file" | "terminal" | "frame" | "agent", data?: Record<string, unknown>) => void;
  onClose: () => void;
}

export const NodeContextMenu = ({ x, y, onCreate, onClose }: Props) => {
  const menuRef = useRef<HTMLDivElement>(null);
  const [agentSubmenuOpen, setAgentSubmenuOpen] = useState(false);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      window.addEventListener("click", handleClick);
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", handleClick);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      className="context-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="context-menu-title">Create Node</div>
      <button
        className="context-menu-item"
        onClick={() => onCreate("file")}
      >
        <span className="context-menu-icon">{"\u2756"}</span>
        <span className="context-menu-label">
          <strong>Note</strong>
          <small>Markdown note card</small>
        </span>
      </button>
      <button
        className="context-menu-item"
        onClick={() => onCreate("terminal")}
      >
        <span className="context-menu-icon">{"\u25B6"}</span>
        <span className="context-menu-label">
          <strong>Terminal</strong>
          <small>Run shell commands</small>
        </span>
      </button>
      <button
        className="context-menu-item"
        onClick={() => onCreate("frame")}
      >
        <span className="context-menu-icon">{"\u25A1"}</span>
        <span className="context-menu-label">
          <strong>Frame</strong>
          <small>Visual container group</small>
        </span>
      </button>
      <div
        className={`context-menu-item context-menu-item--submenu${agentSubmenuOpen ? ' context-menu-item--submenu-open' : ''}`}
        onClick={(e) => {
          e.stopPropagation();
          setAgentSubmenuOpen((v) => !v);
        }}
      >
        <span className="context-menu-icon context-menu-icon--agent">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <rect x="3" y="6" width="10" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
            <circle cx="6.5" cy="9.5" r="1" fill="currentColor" />
            <circle cx="9.5" cy="9.5" r="1" fill="currentColor" />
            <path d="M8 6V4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            <circle cx="8" cy="3" r="1" fill="currentColor" />
          </svg>
        </span>
        <span className="context-menu-label">
          <strong>Agent</strong>
          <small>Launch a coding agent</small>
        </span>
        <span className="context-menu-chevron">{"\u25B8"}</span>

        {agentSubmenuOpen && (
          <div className="context-submenu">
            {AGENT_OPTIONS.map((agent) => (
              <button
                key={agent.type}
                className="context-menu-item"
                onClick={(e) => {
                  e.stopPropagation();
                  onCreate("agent", { agentType: agent.type, agentCommand: agent.command });
                }}
              >
                <span className="context-menu-label">
                  <strong>{agent.label}</strong>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
