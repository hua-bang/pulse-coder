import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import type { CanvasNode, FileNodeData } from '../types';

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

const AUTO_SAVE_MS = 1500;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getMarkdown = (editor: any): string => {
  return (editor?.storage?.markdown?.getMarkdown() as string | undefined) ?? '';
};

interface BubbleState {
  x: number;
  y: number;
}

export const FileNodeBody = ({ node, onUpdate }: Props) => {
  const data = node.data as FileNodeData;
  const [modified, setModified] = useState(false);
  const [statusText, setStatusText] = useState('');
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const nodeIdRef = useRef(node.id);
  nodeIdRef.current = node.id;
  const prevContentRef = useRef(data.content);
  const containerRef = useRef<HTMLDivElement>(null);

  const showStatus = useCallback((msg: string, duration = 2000) => {
    setStatusText(msg);
    setTimeout(() => setStatusText(''), duration);
  }, []);

  const persistToFile = useCallback(
    async (markdown: string, filePath: string) => {
      const api = window.canvasWorkspace?.file;
      if (!api || !filePath) return;
      const res = await api.write(filePath, markdown);
      if (res.ok) {
        setModified(false);
        onUpdate(nodeIdRef.current, {
          data: { ...dataRef.current, content: markdown, saved: true, modified: false },
        });
        showStatus('Saved');
      }
    },
    [onUpdate, showStatus]
  );

  const editor = useEditor({
    extensions: [
      StarterKit,
      Placeholder.configure({ placeholder: 'Start writing…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, transformPastedText: true }),
    ],
    content: data.content || '',
    onUpdate: ({ editor }) => {
      const markdown = getMarkdown(editor);
      setModified(true);
      onUpdate(nodeIdRef.current, {
        data: { ...dataRef.current, content: markdown, modified: true },
      });
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const fp = dataRef.current.filePath;
        if (fp) void persistToFile(markdown, fp);
      }, AUTO_SAVE_MS);
    },
    onSelectionUpdate: ({ editor }) => {
      if (editor.state.selection.empty) {
        setBubble(null);
        return;
      }
      requestAnimationFrame(() => {
        const domSel = window.getSelection();
        if (!domSel || domSel.rangeCount === 0 || !containerRef.current) {
          setBubble(null);
          return;
        }
        const selRect = domSel.getRangeAt(0).getBoundingClientRect();
        const boxRect = containerRef.current.getBoundingClientRect();
        setBubble({
          x: selRect.left + selRect.width / 2 - boxRect.left,
          y: selRect.top - boxRect.top,
        });
      });
    },
    onBlur: () => setBubble(null),
  });

  // Sync content when file opens externally
  useEffect(() => {
    if (!editor || data.content === prevContentRef.current) return;
    prevContentRef.current = data.content;
    editor.commands.setContent(data.content || '');
    setModified(false);
  }, [data.content, editor]);

  // Cmd+S / Ctrl+S
  useEffect(() => {
    if (!editor) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const fp = dataRef.current.filePath;
        if (fp) {
          const markdown = getMarkdown(editor);
          void persistToFile(markdown, fp);
        }
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor, persistToFile]);

  const handleOpenFile = useCallback(async () => {
    const api = window.canvasWorkspace?.file;
    if (!api) return;
    const res = await api.openDialog();
    if (!res.ok || res.canceled) return;
    const content = res.content || '';
    prevContentRef.current = content;
    editor?.commands.setContent(content);
    setModified(false);
    onUpdate(nodeIdRef.current, {
      title: res.fileName || node.title,
      data: { filePath: res.filePath || '', content, saved: true, modified: false },
    });
    showStatus(`Opened ${res.fileName}`);
  }, [editor, node.title, onUpdate, showStatus]);

  const handleSaveAs = useCallback(async () => {
    const api = window.canvasWorkspace?.file;
    if (!api || !editor) return;
    const defaultName = dataRef.current.filePath
      ? dataRef.current.filePath.split('/').pop() || 'untitled.md'
      : (node.title || 'untitled') + '.md';
    const markdown = getMarkdown(editor);
    const res = await api.saveAsDialog(defaultName, markdown);
    if (!res.ok || res.canceled) return;
    setModified(false);
    onUpdate(nodeIdRef.current, {
      title: res.fileName || node.title,
      data: {
        ...dataRef.current,
        filePath: res.filePath || dataRef.current.filePath,
        content: markdown,
        saved: true,
        modified: false,
      },
    });
    showStatus(`Saved to ${res.fileName}`);
  }, [editor, node.title, onUpdate, showStatus]);

  const handleManualSave = useCallback(() => {
    const fp = dataRef.current.filePath;
    if (fp && editor) {
      void persistToFile(getMarkdown(editor), fp);
    } else {
      void handleSaveAs();
    }
  }, [editor, persistToFile, handleSaveAs]);

  const filePath = data.filePath;
  const fileName = filePath ? filePath.split('/').pop() : null;

  return (
    <div className="note-card" ref={containerRef}>
      {/* Toolbar */}
      <div className="note-toolbar">
        <div className="note-toolbar-left">
          <button className="note-tool-btn" onClick={handleOpenFile} title="Open file">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path
                d="M2 4.5C2 3.67 2.67 3 3.5 3H6l1.5 2h5c.83 0 1.5.67 1.5 1.5V12c0 .83-.67 1.5-1.5 1.5h-9A1.5 1.5 0 012 12V4.5z"
                stroke="currentColor"
                strokeWidth="1.2"
              />
            </svg>
          </button>
          <button className="note-tool-btn" onClick={handleManualSave} title="Save (Cmd+S)">
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
          <button className="note-tool-btn" onClick={handleSaveAs} title="Save as…">
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

      {fileName && (
        <div className="note-file-hint" title={filePath ?? undefined}>
          {fileName}
        </div>
      )}

      {/* Inline bubble menu — appears above selected text */}
      {bubble && editor && (
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
        </div>
      )}

      <div className="note-content">
        <EditorContent editor={editor} className="note-tiptap-editor" />
      </div>
    </div>
  );
};
