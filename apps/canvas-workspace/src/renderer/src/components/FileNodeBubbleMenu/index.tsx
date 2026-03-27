import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/react';
import type { BubbleState } from '../../hooks/useFileNodeEditor';

interface Props {
  editor: Editor;
  bubble: BubbleState;
}

export const FileNodeBubbleMenu = ({ editor, bubble }: Props) => createPortal(
  <div
    className="note-bubble-menu"
    style={{ left: bubble.x, top: bubble.y }}
    onMouseDown={(e) => e.preventDefault()}
  >
    <button
      className={`note-bubble-btn ${editor.isActive('bold') ? 'note-bubble-btn--active' : ''}`}
      onClick={() => editor.chain().focus().toggleBold().run()}
      title="Bold"
    >
      <strong>B</strong>
    </button>
    <button
      className={`note-bubble-btn ${editor.isActive('italic') ? 'note-bubble-btn--active' : ''}`}
      onClick={() => editor.chain().focus().toggleItalic().run()}
      title="Italic"
    >
      <em>I</em>
    </button>
    <button
      className={`note-bubble-btn ${editor.isActive('code') ? 'note-bubble-btn--active' : ''}`}
      onClick={() => editor.chain().focus().toggleCode().run()}
      title="Inline code"
    >
      <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>`·`</span>
    </button>
    <div className="note-bubble-divider" />
    <button
      className={`note-bubble-btn ${editor.isActive('heading', { level: 1 }) ? 'note-bubble-btn--active' : ''}`}
      onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
      title="Heading 1"
    >
      H1
    </button>
    <button
      className={`note-bubble-btn ${editor.isActive('heading', { level: 2 }) ? 'note-bubble-btn--active' : ''}`}
      onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
      title="Heading 2"
    >
      H2
    </button>
    <button
      className={`note-bubble-btn ${editor.isActive('heading', { level: 3 }) ? 'note-bubble-btn--active' : ''}`}
      onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
      title="Heading 3"
    >
      H3
    </button>
    <div className="note-bubble-divider" />
    <button
      className={`note-bubble-btn ${editor.isActive('bulletList') ? 'note-bubble-btn--active' : ''}`}
      onClick={() => editor.chain().focus().toggleBulletList().run()}
      title="Bullet list"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path
          d="M6 4h7M6 8h7M6 12h7"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
        <circle cx="3" cy="4" r="1.1" fill="currentColor" />
        <circle cx="3" cy="8" r="1.1" fill="currentColor" />
        <circle cx="3" cy="12" r="1.1" fill="currentColor" />
      </svg>
    </button>
    <button
      className={`note-bubble-btn ${editor.isActive('blockquote') ? 'note-bubble-btn--active' : ''}`}
      onClick={() => editor.chain().focus().toggleBlockquote().run()}
      title="Blockquote"
    >
      <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
        <path d="M3 3v10" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        <path
          d="M6 5h7M6 8h5M6 11h6"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
        />
      </svg>
    </button>
  </div>,
  document.body,
);
