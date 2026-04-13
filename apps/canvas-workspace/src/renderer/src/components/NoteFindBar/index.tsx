import { useEffect, useRef, useState } from 'react';
import './index.css';
import type { Editor } from '@tiptap/react';
import {
  clearNoteSearch,
  getNoteSearchState,
  navigateNoteSearch,
  replaceAllMatches,
  replaceCurrentMatch,
  setNoteSearch,
} from '../../editor/noteSearchExtension';

interface Props {
  editor: Editor;
  onClose: () => void;
}

export const NoteFindBar = ({ editor, onClose }: Props) => {
  const [query, setQuery] = useState('');
  const [replacement, setReplacement] = useState('');
  const [showReplace, setShowReplace] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const state = getNoteSearchState(editor.state);
  const total = state?.matches.length ?? 0;
  const current = state?.matches.length ? state.current + 1 : 0;

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  // Clear search decorations when the bar closes
  useEffect(() => {
    return () => clearNoteSearch(editor.view);
  }, [editor]);

  const runSearch = (q: string) => {
    setQuery(q);
    setNoteSearch(editor.view, q);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) navigateNoteSearch(editor.view, -1);
      else navigateNoteSearch(editor.view, 1);
    }
  };

  return (
    <div className="note-find-bar" onMouseDown={(e) => e.stopPropagation()}>
      <div className="note-find-row">
        <button
          className="note-find-toggle"
          onClick={() => setShowReplace((v) => !v)}
          title={showReplace ? 'Hide replace' : 'Show replace'}
        >
          {showReplace ? '▾' : '▸'}
        </button>
        <input
          ref={inputRef}
          className="note-find-input"
          placeholder="Find"
          value={query}
          onChange={(e) => runSearch(e.target.value)}
          onKeyDown={handleKeyDown}
        />
        <span className="note-find-count">
          {total > 0 ? `${current}/${total}` : query ? '0/0' : ''}
        </span>
        <button
          className="note-find-nav"
          onClick={() => navigateNoteSearch(editor.view, -1)}
          disabled={total === 0}
          title="Previous (Shift+Enter)"
        >
          ‹
        </button>
        <button
          className="note-find-nav"
          onClick={() => navigateNoteSearch(editor.view, 1)}
          disabled={total === 0}
          title="Next (Enter)"
        >
          ›
        </button>
        <button className="note-find-close" onClick={onClose} title="Close (Esc)">
          ×
        </button>
      </div>
      {showReplace && (
        <div className="note-find-row">
          <span className="note-find-toggle note-find-toggle--spacer" />
          <input
            className="note-find-input"
            placeholder="Replace"
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') onClose();
            }}
          />
          <button
            className="note-find-action"
            onClick={() => replaceCurrentMatch(editor.view, replacement)}
            disabled={total === 0}
          >
            Replace
          </button>
          <button
            className="note-find-action"
            onClick={() => replaceAllMatches(editor.view, replacement)}
            disabled={total === 0}
          >
            All
          </button>
        </div>
      )}
    </div>
  );
};
