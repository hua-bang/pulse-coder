import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import { Markdown } from 'tiptap-markdown';
import type { CanvasNode, FileNodeData } from '../types';
import type { SlashCommandDef } from '../components/SlashCommandMenu';
import { ALL_SLASH_COMMANDS, filterCmds } from '../editor/slashCommands';

interface SlashMenuState {
  x: number;
  y: number;
  query: string;
  index: number;
  slashFrom: number;
}

export interface BubbleState {
  x: number;
  y: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getMarkdown = (editor: any): string =>
  (editor?.storage?.markdown?.getMarkdown() as string | undefined) ?? '';

interface Options {
  data: FileNodeData;
  nodeIdRef: React.MutableRefObject<string>;
  dataRef: React.MutableRefObject<FileNodeData>;
  workspaceIdRef: React.MutableRefObject<string | undefined>;
  prevContentRef: React.MutableRefObject<string>;
  setModified: (val: boolean) => void;
  persistToFile: (markdown: string, filePath: string) => Promise<void>;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

const AUTO_SAVE_MS = 1500;

export const useFileNodeEditor = ({
  data,
  nodeIdRef,
  dataRef,
  workspaceIdRef,
  prevContentRef,
  setModified,
  persistToFile,
  onUpdate,
}: Options) => {
  const [bubble, setBubble] = useState<BubbleState | null>(null);
  const [slashMenu, setSlashMenu] = useState<SlashMenuState | null>(null);
  const slashMenuRef = useRef<SlashMenuState | null>(null);
  slashMenuRef.current = slashMenu;
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
        if (!domSel || domSel.rangeCount === 0) {
          setBubble(null);
          return;
        }
        const selRect = domSel.getRangeAt(0).getBoundingClientRect();
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
  }, [data.content, editor, prevContentRef, setModified]);

  // Cmd+S / Ctrl+S
  useEffect(() => {
    if (!editor) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        const fp = dataRef.current.filePath;
        if (fp) void persistToFile(getMarkdown(editor), fp);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor, persistToFile, dataRef]);

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

  return { editor, slashMenu, setSlashMenu, bubble, handleSlashSelect };
};
