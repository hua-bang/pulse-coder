import './index.css';

interface Props {
  activeTool: string;
  onToolChange: (tool: string) => void;
  onAddNode: (type: "file" | "terminal" | "frame" | "agent" | "text" | "iframe") => void;
  chatPanelOpen?: boolean;
  onChatToggle?: () => void;
}

const tools = [
  {
    id: "select",
    label: "Select",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path
          d="M4 2l10 6.5L9 10l-1.5 6L4 2z"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinejoin="round"
        />
      </svg>
    )
  },
  {
    id: "hand",
    label: "Pan",
    icon: (
      <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
        <path
          d="M9 2v7M6 5v6.5a2.5 2.5 0 002.5 2.5h3A2.5 2.5 0 0014 11.5V8M6 5a1.5 1.5 0 013 0M12 5a1.5 1.5 0 00-3 0M12 5v3M14 8a1.5 1.5 0 00-3 0"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    )
  }
];

export const FloatingToolbar = ({
  activeTool,
  onToolChange,
  onAddNode,
  chatPanelOpen,
  onChatToggle,
}: Props) => {
  return (
    <div className="floating-toolbar">
      {onChatToggle && (
        <>
          <div className="toolbar-group">
            <button
              className={`toolbar-btn${chatPanelOpen ? " toolbar-btn--active" : ""}`}
              onClick={onChatToggle}
              title="Toggle AI Chat (Cmd/Ctrl+Shift+A)"
            >
              <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                <circle cx="9" cy="6.5" r="3.5" stroke="currentColor" strokeWidth="1.3" />
                <path
                  d="M4.5 16c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"
                  stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
                />
                <circle cx="7.5" cy="6" r="0.7" fill="currentColor" />
                <circle cx="10.5" cy="6" r="0.7" fill="currentColor" />
              </svg>
            </button>
          </div>
          <div className="toolbar-divider" />
        </>
      )}

      <div className="toolbar-group">
        {tools.map((t) => (
          <button
            key={t.id}
            className={`toolbar-btn${activeTool === t.id ? " toolbar-btn--active" : ""}`}
            onClick={() => onToolChange(t.id)}
            title={t.label}
          >
            {t.icon}
          </button>
        ))}
      </div>

      <div className="toolbar-divider" />

      <div className="toolbar-group">
        <button
          className="toolbar-btn toolbar-btn--create"
          onClick={() => onAddNode("text")}
          title="Add Text"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path
              d="M4 5h10M9 5v9M7 14h4"
              stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"
            />
          </svg>
          <span className="toolbar-btn-label">Text</span>
        </button>
        <button
          className="toolbar-btn toolbar-btn--create"
          onClick={() => onAddNode("file")}
          title="Add Note Card"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect
              x="3" y="3" width="12" height="12" rx="2"
              stroke="currentColor" strokeWidth="1.3"
            />
            <path
              d="M7 9h4M9 7v4"
              stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
            />
          </svg>
          <span className="toolbar-btn-label">Note</span>
        </button>
        <button
          className="toolbar-btn toolbar-btn--create"
          onClick={() => onAddNode("terminal")}
          title="Add Terminal Card"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect
              x="2" y="3" width="14" height="12" rx="2"
              stroke="currentColor" strokeWidth="1.3"
            />
            <path
              d="M5 8l2.5 2L5 12M9 12h4"
              stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"
            />
          </svg>
          <span className="toolbar-btn-label">Terminal</span>
        </button>
        <button
          className="toolbar-btn toolbar-btn--create"
          onClick={() => onAddNode("frame")}
          title="Add Frame"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <rect
              x="2" y="2" width="14" height="14" rx="2.5"
              stroke="currentColor" strokeWidth="1.3"
            />
            <rect
              x="5" y="5" width="8" height="8" rx="1"
              stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.5"
            />
          </svg>
          <span className="toolbar-btn-label">Frame</span>
        </button>
        <button
          className="toolbar-btn toolbar-btn--create"
          onClick={() => onAddNode("iframe")}
          title="Add Link (embed a web page)"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="9" r="6.5" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M2.5 9h13M9 2.5c2.2 2.2 2.2 10.8 0 13M9 2.5c-2.2 2.2-2.2 10.8 0 13"
              stroke="currentColor" strokeWidth="1.2" strokeLinecap="round"
            />
          </svg>
          <span className="toolbar-btn-label">Link</span>
        </button>
        <button
          className="toolbar-btn toolbar-btn--create"
          onClick={() => onAddNode("agent")}
          title="Add Agent Card"
        >
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <circle cx="9" cy="6.5" r="3.5" stroke="currentColor" strokeWidth="1.3" />
            <path
              d="M4.5 16c0-2.5 2-4.5 4.5-4.5s4.5 2 4.5 4.5"
              stroke="currentColor" strokeWidth="1.3" strokeLinecap="round"
            />
            <circle cx="7.5" cy="6" r="0.7" fill="currentColor" />
            <circle cx="10.5" cy="6" r="0.7" fill="currentColor" />
          </svg>
          <span className="toolbar-btn-label">Agent</span>
        </button>
      </div>
    </div>
  );
};
