interface Props {
  onOpenFile: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  statusText: string;
  modified: boolean;
}

export const FileNodeToolbar = ({ onOpenFile, onSave, onSaveAs, statusText, modified }: Props) => (
  <div className="note-toolbar">
    <div className="note-toolbar-left">
      <button className="note-tool-btn" onClick={onOpenFile} title="Open file">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 2h5c.83 0 1.5.67 1.5 1.5V12c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z"
            stroke="currentColor"
            strokeWidth="1.2"
          />
        </svg>
      </button>
      <button className="note-tool-btn" onClick={onSave} title="Save (Cmd+S)">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M12.5 14h-9A1.5 1.5 0 012 12.5v-9A1.5 1.5 0 013.5 2H10l4 4v6.5a1.5 1.5 0 01-1.5 1.5z"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path d="M5 2v4h5V2" stroke="currentColor" strokeWidth="1.2" />
          <path d="M5 10h6" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
      </button>
      <button className="note-tool-btn" onClick={onSaveAs} title="Save as…">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M12.5 14h-9A1.5 1.5 0 012 12.5v-9A1.5 1.5 0 013.5 2H10l4 4v6.5a1.5 1.5 0 01-1.5 1.5z"
            stroke="currentColor"
            strokeWidth="1.2"
          />
          <path
            d="M8 7v5M6 10l2 2 2-2"
            stroke="currentColor"
            strokeWidth="1.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </div>
    <div className="note-toolbar-right">
      {statusText && <span className="note-status">{statusText}</span>}
      {modified && !statusText && (
        <span className="note-status note-status--modified">Edited</span>
      )}
    </div>
  </div>
);
