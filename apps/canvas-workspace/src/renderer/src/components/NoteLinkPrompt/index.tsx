import { useEffect, useRef, useState } from 'react';
import './index.css';

interface Props {
  initial: string;
  onApply: (url: string) => void;
  onCancel: () => void;
}

export const NoteLinkPrompt = ({ initial, onApply, onCancel }: Props) => {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onApply(value);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  return (
    <div className="note-link-prompt" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={inputRef}
        className="note-link-input"
        placeholder="https://example.com"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      <button className="note-link-action" onClick={() => onApply(value)} title="Apply (Enter)">
        Apply
      </button>
      {initial && (
        <button
          className="note-link-action note-link-action--danger"
          onClick={() => onApply('')}
          title="Remove link"
        >
          Remove
        </button>
      )}
      <button className="note-link-close" onClick={onCancel} title="Cancel (Esc)">
        ×
      </button>
    </div>
  );
};
