import { useCallback, useRef, useState } from 'react';
import { EditorContent } from '@tiptap/react';
import type { CanvasNode, FileNodeData } from '../../types';
import { useFileNodeEditor, getMarkdown } from '../../hooks/useFileNodeEditor';
import { filterCmds } from '../../editor/slashCommands';
import { FileNodeToolbar } from '../FileNodeToolbar';
import { FileNodeBubbleMenu } from '../FileNodeBubbleMenu';
import { SlashCommandMenu } from '../SlashCommandMenu';

interface Props {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  workspaceId?: string;
}

export const FileNodeBody = ({ node, onUpdate, workspaceId }: Props) => {
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

  const { editor, slashMenu, setSlashMenu, bubble, handleSlashSelect } = useFileNodeEditor({
    data,
    nodeIdRef,
    dataRef,
    workspaceIdRef,
    prevContentRef,
    setModified,
    persistToFile,
    onUpdate,
  });

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
    <div className="note-card">
      <FileNodeToolbar
        onOpenFile={handleOpenFile}
        onSave={handleManualSave}
        onSaveAs={handleSaveAs}
        statusText={statusText}
        modified={modified}
      />

      {fileName && (
        <div className="note-file-hint" title={filePath ?? undefined}>
          {fileName}
        </div>
      )}

      {bubble && editor && <FileNodeBubbleMenu editor={editor} bubble={bubble} />}

      <div className="note-content" onWheel={(e) => e.stopPropagation()}>
        <EditorContent editor={editor} className="note-tiptap-editor" />
      </div>

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
