import { useCallback, useEffect, useRef, useState } from 'react';
import './index.css';
import { EditorContent } from '@tiptap/react';
import type { CanvasNode, FileNodeData } from '../../types';
import { useFileNodeEditor, getMarkdown } from '../../hooks/useFileNodeEditor';
import { useFileNodeEditorRegistry } from '../../hooks/useFileNodeEditorRegistry';
import { filterCmds } from '../../editor/slashCommands';
import { FileNodeToolbar } from '../FileNodeToolbar';
import { FileNodeBubbleMenu } from '../FileNodeBubbleMenu';
import { SlashCommandMenu } from '../SlashCommandMenu';
import { NoteFindBar } from '../NoteFindBar';
import { NoteLinkPrompt } from '../NoteLinkPrompt';

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  workspaceId?: string;
  readOnly?: boolean;
}

export const FileNodeBody = ({ node, onUpdate, workspaceId, readOnly = false }: Props) => {
  const data = node.data as FileNodeData;
  const [modified, setModified] = useState(false);
  const [statusText, setStatusText] = useState('');
  const dataRef = useRef(data);
  dataRef.current = data;
  const nodeIdRef = useRef(node.id);
  nodeIdRef.current = node.id;
  const prevContentRef = useRef(data.content);
  const workspaceIdRef = useRef(workspaceId);
  workspaceIdRef.current = workspaceId;

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

  const {
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
  } = useFileNodeEditor({
    data,
    nodeIdRef,
    dataRef,
    workspaceIdRef,
    prevContentRef,
    setModified,
    persistToFile,
    onUpdate,
    readOnly,
  });

  // Publish this node's editor to the canvas-level registry so the
  // Ctrl/Cmd+F find bar can push its query into our NoteSearchExtension
  // and reuse the inline match highlights (no separate decoration
  // system for canvas-vs-note find). Re-registers if the editor
  // identity changes (Tiptap may rebuild on extension changes).
  const registry = useFileNodeEditorRegistry();
  useEffect(() => {
    if (!registry || !editor) return;
    const id = node.id;
    registry.register(id, editor);
    return () => registry.unregister(id);
  }, [registry, editor, node.id]);

  const handleOpenFile = useCallback(async () => {
    if (readOnly) return;
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
  }, [editor, node.title, onUpdate, showStatus, readOnly]);

  const handleSaveAs = useCallback(async () => {
    if (readOnly) return;
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
  }, [editor, node.title, onUpdate, showStatus, readOnly]);

  const handleManualSave = useCallback(() => {
    if (readOnly) return;
    const fp = dataRef.current.filePath;
    if (fp && editor) {
      void persistToFile(getMarkdown(editor), fp);
    } else {
      void handleSaveAs();
    }
  }, [editor, persistToFile, handleSaveAs, readOnly]);

  const handleImageInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (readOnly) return;
      const file = e.target.files?.[0];
      if (file) void insertImageFromFile(file);
      e.target.value = '';
    },
    [insertImageFromFile, readOnly],
  );

  const filePath = data.filePath;
  const fileName = filePath ? filePath.split('/').pop() : null;

  return (
    <div className="note-card">
      {!readOnly && (
        <FileNodeToolbar
          onOpenFile={handleOpenFile}
          onSave={handleManualSave}
          onSaveAs={handleSaveAs}
          onInsertImage={openImagePicker}
          onOpenFind={openFindBar}
          statusText={statusText}
          modified={modified}
        />
      )}

      {fileName && (
        <div className="note-file-hint" title={filePath ?? undefined}>
          {fileName}
        </div>
      )}

      {!readOnly && findBarOpen && editor && <NoteFindBar editor={editor} onClose={closeFindBar} />}

      {!readOnly && linkPrompt && (
        <NoteLinkPrompt
          initial={linkPrompt.initial}
          onApply={applyLink}
          onCancel={cancelLink}
        />
      )}

      {!readOnly && bubble && editor && (
        <FileNodeBubbleMenu editor={editor} bubble={bubble} onOpenLinkPrompt={openLinkPrompt} />
      )}

      <div
        className="note-content"
        onPaste={(e) => e.stopPropagation()}
        onWheel={(e) => e.stopPropagation()}
      >
        <EditorContent editor={editor} className="note-tiptap-editor" />
      </div>

      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={handleImageInputChange}
      />

      {!readOnly && slashMenu && (
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
