import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import type { CanvasNode, FileNodeData } from '../types';
import { SlashCommandMenu, type SlashCommandDef } from './SlashCommandMenu';

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  workspaceId?: string;
}

const AUTO_SAVE_MS = 1500;

// ---- Slash command definitions ----

interface SlashCmd extends SlashCommandDef {
  run: (editor: Editor, from: number, to: number) => void;
}

const ALL_SLASH_COMMANDS: SlashCmd[] = [
  {
    id: 'text', label: 'Text', desc: 'Plain paragraph', icon: 'T',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).clearNodes().run(),
  },
  {
    id: 'h1', label: 'Heading 1', desc: 'Large section heading', icon: 'H1',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleHeading({ level: 1 }).run(),
  },
  {
    id: 'h2', label: 'Heading 2', desc: 'Medium section heading', icon: 'H2',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleHeading({ level: 2 }).run(),
  },
  {
    id: 'h3', label: 'Heading 3', desc: 'Small section heading', icon: 'H3',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleHeading({ level: 3 }).run(),
  },
  {
    id: 'ul', label: 'Bullet List', desc: 'Unordered list', icon: '•',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleBulletList().run(),
  },
  {
    id: 'ol', label: 'Numbered List', desc: 'Ordered list', icon: '1.',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleOrderedList().run(),
  },
  {
    id: 'task', label: 'Task List', desc: 'Todo checklist', icon: '☑',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleTaskList().run(),
  },
  {
    id: 'quote', label: 'Blockquote', desc: 'Quote / callout block', icon: '"',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleBlockquote().run(),
  },
  {
    id: 'code', label: 'Code Block', desc: 'Code snippet', icon: '</>',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).toggleCodeBlock().run(),
  },
  {
    id: 'hr', label: 'Divider', desc: 'Horizontal line', icon: '—',
    run: (e, f, t) => e.chain().focus().deleteRange({ from: f, to: t }).setHorizontalRule().run(),
  },
];

const filterCmds = (query: string): SlashCmd[] => {
  if (!query) return ALL_SLASH_COMMANDS;
  const q = query.toLowerCase();
  return ALL_SLASH_COMMANDS.filter(
    (c) => c.label.toLowerCase().includes(q) || c.id.includes(q) || c.desc.toLowerCase().includes(q),
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getMarkdown = (editor: any): string => {
  return (editor?.storage?.markdown?.getMarkdown() as string | undefined) ?? '';
};

interface BubbleState {
  x: number;
  y: number;
}

export const FileNodeBody = ({ node, onUpdate, workspaceId }: Props) => {
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
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

  // Slash command menu state
  interface SlashMenuState { x: number; y: number; query: string; index: number; slashFrom: number }
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const slashMenuRef = useRef<SlashMenuState | null>(null);
  slashMenuRef.current = slashMenu;

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
      Image.configure({ inline: false }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Markdown.configure({ html: false, transformPastedText: true }),
    ],
    content: data.content || '',
    editorProps: {
      handlePaste: (view, event) => {
        const items = Array.from(event.clipboardData?.items ?? []);
        const imageItem = items.find((i) => i.type.startsWith('image/'));
        if (!imageItem) return false;
        event.preventDefault();
        const blob = imageItem.getAsFile();
        if (!blob) return false;
        const reader = new FileReader();
        reader.onload = async () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.split(',')[1];
          if (!base64) return;
          const ext = imageItem.type.replace('image/', '').split(';')[0] ?? 'png';
          const api = window.canvasWorkspace?.file;
          if (!api) return;
          // Derive workspaceId from file path if prop is not provided
          const wsId =
            workspaceIdRef.current ??
            dataRef.current.filePath.match(/canvas[/\\]([^/\\]+)[/\\]/)?.[1] ??
            'default';
          const res = await api.saveImage(wsId, base64, ext);
          if (!res.ok || !res.filePath) return;
          const src = `file://${res.filePath}`;
          const { state, dispatch } = view;
          const imageNode = state.schema.nodes['image']?.create({ src });
          if (imageNode) {
            dispatch(state.tr.replaceSelectionWith(imageNode));
          }
        };
        reader.readAsDataURL(blob);
        return true;
      },
    },
    onUpdate: ({ editor }) => {
      const markdown = getMarkdown(editor);
      prevContentRef.current = markdown;
      setModified(true);
      onUpdate(nodeIdRef.current, {
        data: { ...dataRef.current, content: markdown, modified: true },
      });
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(() => {
        const fp = dataRef.current.filePath;
        if (fp) void persistToFile(markdown, fp);
      }, AUTO_SAVE_MS);

      // Slash command detection: match /query at end of current text block
      const { from } = editor.state.selection;
      const startPos = Math.max(0, from - 60);
      const textBefore = editor.state.doc.textBetween(startPos, from, '\n', '\0');
      const slashMatch = textBefore.match(/(?:^|[\n ])\/(\w*)$/);
      if (slashMatch) {
        const query = slashMatch[1] ?? '';
        const slashDocPos = from - query.length - 1;
        const coords = editor.view.coordsAtPos(slashDocPos);
        setSlashMenu((prev) => ({
          x: coords.left,
          y: coords.bottom,
          query,
          index: prev?.query === query ? prev.index : 0,
          slashFrom: slashDocPos,
        }));
      } else {
        if (slashMenuRef.current) setSlashMenu(null);
      }
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
        // Use viewport coordinates so the menu uses position:fixed and
        // is never clipped by the canvas-node's overflow:hidden.
        setBubble({
          x: selRect.left + selRect.width / 2,
          y: selRect.top,
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

  // Slash menu keyboard navigation — capture phase so we intercept before ProseMirror
  useEffect(() => {
    if (!editor) return;
    const handler = (e: KeyboardEvent) => {
      const menu = slashMenuRef.current;
      if (!menu) return;
      const items = filterCmds(menu.query);
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSlashMenu((prev) => prev ? { ...prev, index: Math.min(prev.index + 1, items.length - 1) } : null);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopImmediatePropagation();
        setSlashMenu((prev) => prev ? { ...prev, index: Math.max(prev.index - 1, 0) } : null);
      } else if (e.key === 'Enter') {
        const item = items[menu.index] ?? items[0];
        if (item) {
          e.preventDefault();
          e.stopImmediatePropagation();
          item.run(editor, menu.slashFrom, editor.state.selection.from);
          setSlashMenu(null);
        }
      } else if (e.key === 'Escape') {
        setSlashMenu(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [editor]);

  const handleSlashSelect = useCallback((cmd: SlashCommandDef) => {
    if (!editor || !slashMenuRef.current) return;
    const { slashFrom } = slashMenuRef.current;
    const fullCmd = ALL_SLASH_COMMANDS.find((c) => c.id === cmd.id);
    fullCmd?.run(editor, slashFrom, editor.state.selection.from);
    setSlashMenu(null);
  }, [editor]);

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

      {/* Bubble menu — portaled to document.body so position:fixed is relative
          to the viewport, not the canvas-transform ancestor. */}
      {bubble && editor && createPortal(
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
      )}

      <div className="note-content" onWheel={(e) => e.stopPropagation()}>
        <EditorContent editor={editor} className="note-tiptap-editor" />
      </div>

      {/* Slash command menu — fixed position, never clipped by canvas overflow */}
      {slashMenu && (
        <SlashCommandMenu
          x={slashMenu.x}
          y={slashMenu.y}
          selectedIndex={slashMenu.index}
          items={filterCmds(slashMenu.query)}
          onSelect={handleSlashSelect}
          onClose={() => setSlashMenu(null)}
        />
      )}
    </div>
  );
};
