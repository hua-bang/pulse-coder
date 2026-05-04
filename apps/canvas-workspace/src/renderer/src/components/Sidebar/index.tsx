import { useEffect, useMemo, useRef, useState, useCallback, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { WorkspaceEntry, FolderEntry } from '../../hooks/useWorkspaces';
import type { CanvasNode } from '../../types';
import './index.css';
import { buildLayerTree, collectFrameIds } from './utils/layers';
import { SidebarHeader, SidebarToggleIcon } from './SidebarHeader';
import { WorkspaceItem } from './WorkspaceItem';
import { WorkspaceList } from './WorkspaceList';
import { LayersPanel } from './LayersPanel';
import { LayerContextMenu } from './LayerContextMenu';
import { useAppShell } from '../AppShellProvider';
import { getNodeDisplayLabel } from '../../utils/nodeLabel';
import { buildCanvasNodeLink } from '../../utils/canvasLinks';
import { copyTextToClipboard } from '../../utils/clipboard';

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  workspaces: WorkspaceEntry[];
  folders: FolderEntry[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onImport: () => void;
  onSetRootFolder: (id: string, folderPath: string) => void;
  onCreateFolder: (name: string) => void;
  onRenameFolder: (id: string, name: string) => void;
  onDeleteFolder: (id: string) => void;
  onToggleFolder: (id: string) => void;
  onMoveWorkspace: (workspaceId: string, folderId: string | undefined) => void;
  onReorderFolder: (folderId: string, beforeFolderId: string | null) => void;
  activeNodes?: CanvasNode[];
  onNodeFocus?: (nodeId: string) => void;
  onNodeDelete?: (nodeId: string) => void;
  onNodeRename?: (nodeId: string, title: string) => void;
  activeView: 'canvas' | 'chat';
  onEnterChat: () => void;
  onExitChat: () => void;
}

const WS_DRAG = 'application/x-workspace-id';
const FOLDER_DRAG = 'application/x-folder-id';

export const Sidebar = ({
  collapsed, onToggle, workspaces, folders, activeId, onSelect, onCreate, onRename, onDelete,
  onExport, onImport, onCreateFolder, onRenameFolder, onDeleteFolder, onToggleFolder, onMoveWorkspace, onReorderFolder,
  activeNodes = [], onNodeFocus, onNodeDelete, onNodeRename, activeView, onEnterChat,
}: Props) => {
  const { confirm, notify } = useAppShell();
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');
  const [renamingLayerId, setRenamingLayerId] = useState<string | null>(null);
  const [renameLayerValue, setRenameLayerValue] = useState('');
  const [inlineCreate, setInlineCreate] = useState<'workspace' | 'folder' | null>(null);
  const [inlineCreateValue, setInlineCreateValue] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set());
  const [layerContextMenu, setLayerContextMenu] = useState<{ x: number; y: number; nodeId: string } | null>(null);

  const layerTree = useMemo(() => buildLayerTree(activeNodes), [activeNodes]);
  const frameIds = useMemo(() => collectFrameIds(layerTree), [layerTree]);
  const anyFrameExpanded = useMemo(() => frameIds.some((id) => !collapsedLayers.has(id)), [frameIds, collapsedLayers]);

  const toggleAllLayers = useCallback(() => {
    setCollapsedLayers((prev) => {
      if (frameIds.length === 0) return prev;
      return frameIds.some((id) => !prev.has(id)) ? new Set(frameIds) : new Set<string>();
    });
  }, [frameIds]);

  const handleLayerContextMenu = useCallback((e: ReactMouseEvent, nodeId: string) => {
    e.preventDefault(); e.stopPropagation();
    setLayerContextMenu({ x: e.clientX, y: e.clientY, nodeId });
  }, []);

  useEffect(() => {
    if (!layerContextMenu) return;
    const close = () => setLayerContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setLayerContextMenu(null); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', onKey); };
  }, [layerContextMenu]);

  const toggleLayerCollapse = useCallback((id: string) => {
    setCollapsedLayers((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameFolderInputRef = useRef<HTMLInputElement>(null);
  const renameLayerInputRef = useRef<HTMLInputElement>(null);
  const inlineCreateRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { if (renamingId && renameInputRef.current) { renameInputRef.current.focus(); renameInputRef.current.select(); } }, [renamingId]);
  useEffect(() => { if (renamingFolderId && renameFolderInputRef.current) { renameFolderInputRef.current.focus(); renameFolderInputRef.current.select(); } }, [renamingFolderId]);
  useEffect(() => { if (renamingLayerId && renameLayerInputRef.current) { renameLayerInputRef.current.focus(); renameLayerInputRef.current.select(); } }, [renamingLayerId]);
  useEffect(() => { if (inlineCreate && inlineCreateRef.current) inlineCreateRef.current.focus(); }, [inlineCreate]);

  useEffect(() => {
    if (!showAddMenu) return;
    const handler = (e: MouseEvent) => { if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setShowAddMenu(false); };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAddMenu]);

  const startRename = (ws: WorkspaceEntry) => { setRenamingId(ws.id); setRenameValue(ws.name); };
  const commitRename = () => { if (renamingId && renameValue.trim()) onRename(renamingId, renameValue); setRenamingId(null); };
  const startFolderRename = (f: FolderEntry) => { setRenamingFolderId(f.id); setRenameFolderValue(f.name); };
  const commitFolderRename = () => { if (renamingFolderId && renameFolderValue.trim()) onRenameFolder(renamingFolderId, renameFolderValue); setRenamingFolderId(null); };
  const startLayerRename = (nodeId: string) => {
    const node = activeNodes.find((item) => item.id === nodeId);
    if (!node) return;
    setRenamingLayerId(nodeId);
    setRenameLayerValue(node.title || getNodeDisplayLabel(node));
  };
  const commitLayerRename = () => {
    if (!renamingLayerId) return;
    const nextTitle = renameLayerValue.trim();
    const node = activeNodes.find((item) => item.id === renamingLayerId);
    setRenamingLayerId(null);
    if (!node || !onNodeRename || !nextTitle || node.title === nextTitle) return;
    onNodeRename(renamingLayerId, nextTitle);
    notify({
      tone: 'success',
      title: 'Layer renamed',
      description: `${getNodeDisplayLabel(node)} -> ${nextTitle}`,
    });
  };
  const commitInlineCreate = () => {
    const v = inlineCreateValue.trim();
    if (v) { if (inlineCreate === 'workspace') onCreate(v); else if (inlineCreate === 'folder') onCreateFolder(v); }
    setInlineCreate(null); setInlineCreateValue('');
  };

  const handleLayerDelete = useCallback(async (nodeId: string) => {
    const node = activeNodes.find((item) => item.id === nodeId);
    if (!node || !onNodeDelete) return;

    const accepted = await confirm({
      intent: 'danger',
      title: `Delete "${getNodeDisplayLabel(node)}"?`,
      description: 'The node will be removed from the canvas. Connected arrows remain and detach from it.',
      confirmLabel: 'Delete node',
    });
    if (!accepted) return;

    onNodeDelete(nodeId);
    notify({
      tone: 'success',
      title: 'Node deleted',
      description: getNodeDisplayLabel(node),
    });
  }, [activeNodes, confirm, notify, onNodeDelete]);

  const handleLayerCopyLink = useCallback(async (nodeId: string) => {
    const node = activeNodes.find((item) => item.id === nodeId);
    if (!node) return;

    try {
      await copyTextToClipboard(buildCanvasNodeLink(activeId, nodeId));
      notify({
        tone: 'success',
        title: 'Node link copied',
        description: getNodeDisplayLabel(node),
      });
    } catch (error) {
      notify({
        tone: 'error',
        title: 'Copy failed',
        description: error instanceof Error ? error.message : 'Unable to copy the node link.',
        autoCloseMs: 4200,
      });
    }
  }, [activeNodes, activeId, notify]);

  // Workspace drag
  const handleWsDragStart = (e: DragEvent, wsId: string) => {
    e.dataTransfer.setData(WS_DRAG, wsId); e.dataTransfer.effectAllowed = 'move';
    (e.currentTarget as HTMLElement).classList.add('sidebar-dragging');
  };
  const handleWsDragEnd = (e: DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('sidebar-dragging'); setDropTarget(null);
  };
  const handleWsDragOver = (e: DragEvent, targetId: string) => {
    if (!e.dataTransfer.types.includes(WS_DRAG)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDropTarget(targetId);
  };
  const handleWsDragLeave = (e: DragEvent, targetId: string) => {
    const rel = e.relatedTarget as HTMLElement | null;
    if (rel && (e.currentTarget as HTMLElement).contains(rel)) return;
    if (dropTarget === targetId) setDropTarget(null);
  };
  const handleWsDrop = (e: DragEvent, folderId: string | undefined) => {
    e.preventDefault(); const wsId = e.dataTransfer.getData(WS_DRAG); if (wsId) onMoveWorkspace(wsId, folderId); setDropTarget(null);
  };

  // Folder drag
  const handleFolderDragStart = (e: DragEvent, folderId: string) => {
    e.dataTransfer.setData(FOLDER_DRAG, folderId); e.dataTransfer.effectAllowed = 'move';
    (e.currentTarget as HTMLElement).classList.add('sidebar-dragging');
  };
  const handleFolderDragEnd = (e: DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('sidebar-dragging'); setFolderDropTarget(null);
  };
  const handleFolderDragOver = (e: DragEvent, targetFolderId: string) => {
    if (!e.dataTransfer.types.includes(FOLDER_DRAG)) return;
    e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setFolderDropTarget(targetFolderId);
  };
  const handleFolderDragLeave = (e: DragEvent, targetFolderId: string) => {
    const rel = e.relatedTarget as HTMLElement | null;
    if (rel && (e.currentTarget as HTMLElement).contains(rel)) return;
    if (folderDropTarget === targetFolderId) setFolderDropTarget(null);
  };
  const handleFolderDrop = (e: DragEvent, beforeFolderId: string | null) => {
    e.preventDefault(); const fid = e.dataTransfer.getData(FOLDER_DRAG);
    if (fid && fid !== beforeFolderId) onReorderFolder(fid, beforeFolderId); setFolderDropTarget(null);
  };

  // Combined folder handlers (receives both WS and folder drags)
  const onFolderCombinedDragOver = (e: DragEvent, folderId: string) => { handleWsDragOver(e, folderId); handleFolderDragOver(e, folderId); };
  const onFolderCombinedDragLeave = (e: DragEvent, folderId: string) => { handleWsDragLeave(e, folderId); handleFolderDragLeave(e, folderId); };
  const onFolderCombinedDrop = (e: DragEvent, folderId: string) => {
    if (e.dataTransfer.types.includes(WS_DRAG)) handleWsDrop(e, folderId);
    else if (e.dataTransfer.types.includes(FOLDER_DRAG)) handleFolderDrop(e, folderId);
  };

  const renderWorkspaceItem = (ws: WorkspaceEntry) => (
    <WorkspaceItem
      key={ws.id} ws={ws} activeId={activeId} activeView={activeView}
      isOnlyWorkspace={workspaces.length <= 1} isRenaming={renamingId === ws.id}
      renameValue={renameValue} renameInputRef={renameInputRef}
      onSelect={onSelect} onStartRename={startRename} onRenameChange={setRenameValue}
      onRenameCommit={commitRename} onRenameCancel={() => setRenamingId(null)}
      onDelete={onDelete} onExport={onExport} onDragStart={handleWsDragStart} onDragEnd={handleWsDragEnd}
    />
  );

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      {!collapsed && (
        <>
          <SidebarHeader
            onToggle={onToggle} activeView={activeView} onEnterChat={onEnterChat}
            showAddMenu={showAddMenu} onToggleAddMenu={() => setShowAddMenu((v) => !v)}
            addMenuRef={addMenuRef}
            onNewWorkspace={() => { setShowAddMenu(false); setInlineCreate('workspace'); setInlineCreateValue(''); }}
            onNewFolder={() => { setShowAddMenu(false); setInlineCreate('folder'); setInlineCreateValue(''); }}
            onImportWorkspace={() => { setShowAddMenu(false); onImport(); }}
          />
          <WorkspaceList
            folders={folders} workspaces={workspaces}
            dropTarget={dropTarget} folderDropTarget={folderDropTarget}
            renamingFolderId={renamingFolderId} renameFolderValue={renameFolderValue}
            renameFolderInputRef={renameFolderInputRef}
            inlineCreate={inlineCreate} inlineCreateValue={inlineCreateValue} inlineCreateRef={inlineCreateRef}
            onFolderDragStart={handleFolderDragStart} onFolderDragEnd={handleFolderDragEnd}
            onFolderCombinedDragOver={onFolderCombinedDragOver}
            onFolderCombinedDragLeave={onFolderCombinedDragLeave}
            onFolderCombinedDrop={onFolderCombinedDrop}
            onRootDragOver={(e) => handleWsDragOver(e, '__root__')}
            onRootDragLeave={(e) => handleWsDragLeave(e, '__root__')}
            onRootDrop={(e) => handleWsDrop(e, undefined)}
            onToggleFolder={onToggleFolder} onStartFolderRename={startFolderRename}
            onFolderRenameChange={setRenameFolderValue} onFolderRenameCommit={commitFolderRename}
            onFolderRenameCancel={() => setRenamingFolderId(null)}
            onDeleteFolder={onDeleteFolder} renderWorkspace={renderWorkspaceItem}
            onInlineCreateChange={setInlineCreateValue} onInlineCreateCommit={commitInlineCreate}
            onInlineCreateCancel={() => { setInlineCreate(null); setInlineCreateValue(''); }}
          />
        </>
      )}

      {!collapsed && activeView === 'canvas' && activeNodes.length > 0 && (
        <LayersPanel
          layerTree={layerTree} frameIds={frameIds} nodeCount={activeNodes.length}
          anyFrameExpanded={anyFrameExpanded} collapsedLayers={collapsedLayers}
          onNodeFocus={(nodeId) => onNodeFocus?.(nodeId)}
          onContextMenu={handleLayerContextMenu} onToggleCollapse={toggleLayerCollapse}
          onToggleAll={toggleAllLayers}
          renamingLayerId={renamingLayerId}
          renameLayerValue={renameLayerValue}
          renameLayerInputRef={renameLayerInputRef}
          onLayerRenameChange={setRenameLayerValue}
          onLayerRenameCommit={commitLayerRename}
          onLayerRenameCancel={() => setRenamingLayerId(null)}
        />
      )}

      {layerContextMenu && (
        <LayerContextMenu
          x={layerContextMenu.x} y={layerContextMenu.y} nodeId={layerContextMenu.nodeId}
          onFocus={(nodeId) => onNodeFocus?.(nodeId)}
          onRename={(nodeId) => startLayerRename(nodeId)}
          onDelete={(nodeId) => { void handleLayerDelete(nodeId); }}
          onCopyLink={(nodeId) => { void handleLayerCopyLink(nodeId); }}
          onClose={() => setLayerContextMenu(null)}
        />
      )}

      {collapsed && (
        <div className="sidebar-collapsed-toggle">
          <button className="sidebar-toggle" onClick={onToggle} title="Expand sidebar">
            <SidebarToggleIcon size={14} />
          </button>
        </div>
      )}
    </aside>
  );
};
