import { useCallback, useEffect, useRef, useState } from 'react';
import { useEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Paragraph from '@tiptap/extension-paragraph';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import { common, createLowlight } from 'lowlight';
import { Markdown } from 'tiptap-markdown';
import type { CanvasNode, FileNodeData } from '../types';
import type { SlashCommandDef } from '../components/SlashCommandMenu';
import { ALL_SLASH_COMMANDS, filterCmds, type SlashCmdContext } from '../editor/slashCommands';
import { NoteSearchExtension } from '../editor/noteSearchExtension';

const lowlight = createLowlight(common);

// Markdown collapses consecutive blank lines into a single paragraph
// separator, so empty paragraphs typed by the user (Enter → Enter) are
// lost after save+reload. Preserve them by emitting a non-breaking space
// during markdown serialization — that keeps one paragraph per blank line
// through the markdown roundtrip, matching the pre-reload editor view.
const EMPTY_PARAGRAPH_MARKER = '\u00A0';

const EmptyLinePreservingParagraph = Paragraph.extend({
  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        serialize(state: any, node: any) {
          if (node.childCount === 0) {
            state.write(EMPTY_PARAGRAPH_MARKER);
          } else {
            state.renderInline(node);
          }
          state.closeBlock(node);
        },
        parse: {},
      },
    };
  },
});

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
  const [linkPrompt, setLinkPrompt] = useState<{ initial: string } | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const [findBarOpen, setFindBarOpen] = useState(false);

  const editor = useEditor({
    extensions: [
      // StarterKit v3 bundles Link + Underline + CodeBlock — disable the
      // built-ins since we register explicit configured versions below.
      // Also disable Paragraph so our empty-line-preserving version wins.
      StarterKit.configure({
        codeBlock: false,
        link: false,
        underline: false,
        paragraph: false,
      }),
      EmptyLinePreservingParagraph,
      Image.configure({ inline: false }),
      Placeholder.configure({ placeholder: 'Start writing…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Underline,
      Highlight.configure({ multicolor: false }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
      }),
      CodeBlockLowlight.configure({ lowlight, defaultLanguage: null }),
      Table.configure({ resizable: false, HTMLAttributes: { class: 'note-table' } }),
      TableRow,
      TableHeader,
      TableCell,
      NoteSearchExtension,
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
          item.run(editor, menu.slashFrom, editor.state.selection.from, slashCtxRef.current);
          setSlashMenu(null);
        }
      } else if (e.key === 'Escape') {
        setSlashMenu(null);
      }
    };
    window.addEventListener('keydown', handler, true);
    return () => window.removeEventListener('keydown', handler, true);
  }, [editor]);

  const slashCtx: SlashCmdContext = {
    requestLink: (initial: string) => setLinkPrompt({ initial }),
    requestImage: () => imageInputRef.current?.click(),
  };
  const slashCtxRef = useRef<SlashCmdContext>(slashCtx);
  slashCtxRef.current = slashCtx;

  const handleSlashSelect = useCallback((cmd: SlashCommandDef) => {
    if (!editor || !slashMenuRef.current) return;
    const { slashFrom } = slashMenuRef.current;
    const fullCmd = ALL_SLASH_COMMANDS.find((c) => c.id === cmd.id);
    fullCmd?.run(editor, slashFrom, editor.state.selection.from, slashCtxRef.current);
    setSlashMenu(null);
  }, [editor]);

  const openLinkPrompt = useCallback(() => {
    if (!editor) return;
    const initial = (editor.getAttributes('link')?.href as string | undefined) ?? '';
    setLinkPrompt({ initial });
  }, [editor]);

  const applyLink = useCallback(
    (url: string) => {
      if (!editor) return;
      const trimmed = url.trim();
      if (trimmed === '') {
        editor.chain().focus().extendMarkRange('link').unsetLink().run();
      } else {
        editor
          .chain()
          .focus()
          .extendMarkRange('link')
          .setLink({ href: trimmed })
          .run();
      }
      setLinkPrompt(null);
    },
    [editor],
  );

  const cancelLink = useCallback(() => setLinkPrompt(null), []);

  const insertImageFromFile = useCallback(
    async (file: File) => {
      if (!editor) return;
      const reader = new FileReader();
      reader.onload = async () => {
        const dataUrl = reader.result as string;
        const base64 = dataUrl.split(',')[1];
        if (!base64) return;
        const ext = file.type.replace('image/', '').split(';')[0] || 'png';
        const api = window.canvasWorkspace?.file;
        if (!api) return;
        const wsId =
          workspaceIdRef.current ??
          dataRef.current.filePath.match(/canvas[/\\]([^/\\]+)[/\\]/)?.[1] ??
          'default';
        const res = await api.saveImage(wsId, base64, ext);
        if (!res.ok || !res.filePath) return;
        editor
          .chain()
          .focus()
          .setImage({ src: `file://${res.filePath}` })
          .run();
      };
      reader.readAsDataURL(file);
    },
    [editor, dataRef, workspaceIdRef],
  );

  const openImagePicker = useCallback(() => imageInputRef.current?.click(), []);

  const openFindBar = useCallback(() => setFindBarOpen(true), []);
  const closeFindBar = useCallback(() => setFindBarOpen(false), []);

  // Cmd/Ctrl+F to open find bar — only when this editor is focused
  useEffect(() => {
    if (!editor) return;
    const handler = (e: KeyboardEvent) => {
      if (!((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'f')) return;
      if (!editor.isFocused) return;
      e.preventDefault();
      setFindBarOpen(true);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [editor]);

  return {
    editor,
    slashMenu,
    setSlashMenu,
    bubble,
    handleSlashSelect,
    linkPrompt,
    openLinkPrompt,
    applyLink,
    cancelLink,
    imageInputRef,
    openImagePicker,
    insertImageFromFile,
    findBarOpen,
    openFindBar,
    closeFindBar,
  };
};
