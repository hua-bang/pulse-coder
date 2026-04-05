import { useEffect, useMemo, useRef, useState, useCallback, type DragEvent, type MouseEvent as ReactMouseEvent } from 'react';
import type { WorkspaceEntry, FolderEntry } from '../../hooks/useWorkspaces';
import type { CanvasNode } from '../../types';
import './index.css';

/* ---- Spatial containment (same logic as useNodeDrag) ---- */
const isInsideFrame = (node: CanvasNode, frame: CanvasNode): boolean => {
  const cx = node.x + node.width / 2;
  const cy = node.y + node.height / 2;
  return (
    cx >= frame.x &&
    cx <= frame.x + frame.width &&
    cy >= frame.y &&
    cy <= frame.y + frame.height
  );
};

interface LayerTreeNode {
  node: CanvasNode;
  children: CanvasNode[];
}

/** Build a tree: frames contain non-frame nodes whose center is inside them. */
const buildLayerTree = (nodes: CanvasNode[]): LayerTreeNode[] => {
  const frames = nodes.filter((n) => n.type === 'frame');
  const nonFrames = nodes.filter((n) => n.type !== 'frame');

  const childrenOf = new Map<string, CanvasNode[]>();
  const assigned = new Set<string>();

  for (const frame of frames) {
    const kids: CanvasNode[] = [];
    for (const n of nonFrames) {
      if (!assigned.has(n.id) && isInsideFrame(n, frame)) {
        kids.push(n);
        assigned.add(n.id);
      }
    }
    childrenOf.set(frame.id, kids);
  }

  const tree: LayerTreeNode[] = [];
  // Frames (with children)
  for (const frame of frames) {
    tree.push({ node: frame, children: childrenOf.get(frame.id) || [] });
  }
  // Root-level non-frame nodes (not inside any frame)
  for (const n of nonFrames) {
    if (!assigned.has(n.id)) {
      tree.push({ node: n, children: [] });
    }
  }
  return tree;
};

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
}

/* ---- Drag data keys ---- */
const WS_DRAG = 'application/x-workspace-id';
const FOLDER_DRAG = 'application/x-folder-id';

export const Sidebar = ({
  collapsed,
  onToggle,
  workspaces,
  folders,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSetRootFolder,
  onCreateFolder,
  onRenameFolder,
  onDeleteFolder,
  onToggleFolder,
  onMoveWorkspace,
  onReorderFolder,
  activeNodes = [],
  onNodeFocus,
  onNodeDelete,
}: Props) => {
  /* ---- Local state ---- */
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renamingFolderId, setRenamingFolderId] = useState<string | null>(null);
  const [renameFolderValue, setRenameFolderValue] = useState('');
  const [inlineCreate, setInlineCreate] = useState<'workspace' | 'folder' | null>(null);
  const [inlineCreateValue, setInlineCreateValue] = useState('');
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [folderDropTarget, setFolderDropTarget] = useState<string | null>(null);
  const [showAddMenu, setShowAddMenu] = useState(false);
  const [collapsedLayers, setCollapsedLayers] = useState<Set<string>>(new Set());
  const [layerContextMenu, setLayerContextMenu] = useState<{
    x: number;
    y: number;
    nodeId: string;
  } | null>(null);

  const layerTree = useMemo(() => buildLayerTree(activeNodes), [activeNodes]);

  const handleLayerContextMenu = useCallback((e: ReactMouseEvent, nodeId: string) => {
    e.preventDefault();
    e.stopPropagation();
    setLayerContextMenu({ x: e.clientX, y: e.clientY, nodeId });
  }, []);

  // Close layer context menu on outside click or Escape
  useEffect(() => {
    if (!layerContextMenu) return;
    const close = () => setLayerContextMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLayerContextMenu(null);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
    };
  }, [layerContextMenu]);

  const toggleLayerCollapse = useCallback((id: string) => {
    setCollapsedLayers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const renameInputRef = useRef<HTMLInputElement>(null);
  const renameFolderInputRef = useRef<HTMLInputElement>(null);
  const inlineCreateRef = useRef<HTMLInputElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);

  /* ---- Focus management ---- */
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (renamingFolderId && renameFolderInputRef.current) {
      renameFolderInputRef.current.focus();
      renameFolderInputRef.current.select();
    }
  }, [renamingFolderId]);

  useEffect(() => {
    if (inlineCreate && inlineCreateRef.current) {
      inlineCreateRef.current.focus();
    }
  }, [inlineCreate]);

  // Close add-menu on outside click
  useEffect(() => {
    if (!showAddMenu) return;
    const handler = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) {
        setShowAddMenu(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [showAddMenu]);

  /* ---- Workspace rename ---- */
  const startRename = (ws: WorkspaceEntry) => {
    setRenamingId(ws.id);
    setRenameValue(ws.name);
  };
  const commitRename = () => {
    if (renamingId && renameValue.trim()) onRename(renamingId, renameValue);
    setRenamingId(null);
  };
  const cancelRename = () => setRenamingId(null);

  /* ---- Folder rename ---- */
  const startFolderRename = (f: FolderEntry) => {
    setRenamingFolderId(f.id);
    setRenameFolderValue(f.name);
  };
  const commitFolderRename = () => {
    if (renamingFolderId && renameFolderValue.trim()) onRenameFolder(renamingFolderId, renameFolderValue);
    setRenamingFolderId(null);
  };
  const cancelFolderRename = () => setRenamingFolderId(null);

  /* ---- Inline create (workspace or folder) ---- */
  const commitInlineCreate = () => {
    const v = inlineCreateValue.trim();
    if (v) {
      if (inlineCreate === 'workspace') onCreate(v);
      else if (inlineCreate === 'folder') onCreateFolder(v);
    }
    setInlineCreate(null);
    setInlineCreateValue('');
  };
  const cancelInlineCreate = () => {
    setInlineCreate(null);
    setInlineCreateValue('');
  };

  /* ---- Skills install ---- */
  const [installStatus, setInstallStatus] = useState<'idle' | 'installing' | 'done' | 'partial'>('idle');
  const [installMessage, setInstallMessage] = useState('');

  const handleInstallSkills = useCallback(async () => {
    const api = window.canvasWorkspace?.skills;
    if (!api) return;
    setInstallStatus('installing');
    setInstallMessage('');
    const result = await api.install();
    if (!result.ok) {
      setInstallStatus('idle');
      setInstallMessage(`Failed: ${result.error}`);
      return;
    }
    if (result.cliInstalled) {
      setInstallStatus('done');
      setInstallMessage('Canvas CLI and Skills installed successfully.');
    } else {
      setInstallStatus('partial');
      setInstallMessage(
        `Skills installed. To enable CLI, run:\n${result.manualCommand ?? 'pnpm --filter @pulse-coder/canvas-cli build && pnpm link --global --filter @pulse-coder/canvas-cli'}`
      );
    }
  }, []);

  /* ---- Workspace drag & drop ---- */
  const handleWsDragStart = (e: DragEvent, wsId: string) => {
    e.dataTransfer.setData(WS_DRAG, wsId);
    e.dataTransfer.effectAllowed = 'move';
    // Add a subtle drag class
    (e.currentTarget as HTMLElement).classList.add('sidebar-dragging');
  };

  const handleWsDragEnd = (e: DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('sidebar-dragging');
    setDropTarget(null);
  };

  const handleDropZoneDragOver = (e: DragEvent, targetId: string) => {
    if (!e.dataTransfer.types.includes(WS_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropTarget(targetId);
  };

  const handleDropZoneDragLeave = (e: DragEvent, targetId: string) => {
    const related = e.relatedTarget as HTMLElement | null;
    const current = e.currentTarget as HTMLElement;
    if (related && current.contains(related)) return;
    if (dropTarget === targetId) setDropTarget(null);
  };

  const handleDropZoneDrop = (e: DragEvent, folderId: string | undefined) => {
    e.preventDefault();
    const wsId = e.dataTransfer.getData(WS_DRAG);
    if (wsId) onMoveWorkspace(wsId, folderId);
    setDropTarget(null);
  };

  /* ---- Folder drag & drop (reorder) ---- */
  const handleFolderDragStart = (e: DragEvent, folderId: string) => {
    e.dataTransfer.setData(FOLDER_DRAG, folderId);
    e.dataTransfer.effectAllowed = 'move';
    (e.currentTarget as HTMLElement).classList.add('sidebar-dragging');
  };

  const handleFolderDragEnd = (e: DragEvent) => {
    (e.currentTarget as HTMLElement).classList.remove('sidebar-dragging');
    setFolderDropTarget(null);
  };

  const handleFolderDragOver = (e: DragEvent, targetFolderId: string) => {
    if (!e.dataTransfer.types.includes(FOLDER_DRAG)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setFolderDropTarget(targetFolderId);
  };

  const handleFolderDragLeave = (e: DragEvent, targetFolderId: string) => {
    const related = e.relatedTarget as HTMLElement | null;
    const current = e.currentTarget as HTMLElement;
    if (related && current.contains(related)) return;
    if (folderDropTarget === targetFolderId) setFolderDropTarget(null);
  };

  const handleFolderDrop = (e: DragEvent, beforeFolderId: string | null) => {
    e.preventDefault();
    const folderId = e.dataTransfer.getData(FOLDER_DRAG);
    if (folderId && folderId !== beforeFolderId) {
      onReorderFolder(folderId, beforeFolderId);
    }
    setFolderDropTarget(null);
  };

  /* ---- Render a single workspace row ---- */
  const renderWorkspaceItem = (ws: WorkspaceEntry) => (
    <div
      key={ws.id}
      className="sidebar-workspace-entry"
      draggable
      onDragStart={(e) => handleWsDragStart(e, ws.id)}
      onDragEnd={handleWsDragEnd}
    >
      <div className="sidebar-item-row">
        {renamingId === ws.id ? (
          <input
            ref={renameInputRef}
            className="sidebar-rename-input"
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === 'Enter') commitRename();
              if (e.key === 'Escape') cancelRename();
            }}
          />
        ) : (
          <button
            className={`sidebar-item${activeId === ws.id ? ' sidebar-item--active' : ''}`}
            onClick={() => onSelect(ws.id)}
            onDoubleClick={() => startRename(ws)}
            title="Double-click to rename"
          >
            <span className="sidebar-item-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
                <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </svg>
            </span>
            <span className="sidebar-item-name">{ws.name}</span>
          </button>
        )}
        {workspaces.length > 1 && renamingId !== ws.id && (
          <button className="sidebar-item-delete" onClick={() => onDelete(ws.id)} title="Delete">
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        )}
      </div>
      {ws.rootFolder && (
        <div className="sidebar-root-folder" title={ws.rootFolder}>
          {ws.rootFolder.split('/').slice(-2).join('/')}
        </div>
      )}
    </div>
  );

  /* ---- Computed ---- */
  const rootWorkspaces = workspaces.filter((ws) => !ws.folderId);

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      {!collapsed && (
        <>
          {/* Section header with add + collapse buttons */}
          <div className="sidebar-section-header">
            <span className="sidebar-section-title">Workspaces</span>
            <div className="sidebar-section-actions" ref={addMenuRef}>
              <button
                className="sidebar-section-btn"
                onClick={() => setShowAddMenu((v) => !v)}
                title="Add workspace or folder"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M8 3v10M3 8h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                </svg>
              </button>
              <button className="sidebar-section-btn" onClick={onToggle} title="Collapse sidebar">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
                  <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
                </svg>
              </button>
              {showAddMenu && (
                <div className="sidebar-add-menu">
                  <button
                    className="sidebar-add-menu-item"
                    onClick={() => { setShowAddMenu(false); setInlineCreate('workspace'); setInlineCreateValue(''); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
                      <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                    </svg>
                    <span>New Workspace</span>
                  </button>
                  <button
                    className="sidebar-add-menu-item"
                    onClick={() => { setShowAddMenu(false); setInlineCreate('folder'); setInlineCreateValue(''); }}
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                    <span>New Folder</span>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Scrollable list area */}
          <div className="sidebar-scroll">
            {/* Folders (shown above root workspaces) */}
            {folders.map((folder) => {
              const folderWorkspaces = workspaces.filter((ws) => ws.folderId === folder.id);
              const isOpen = !folder.collapsed;
              const isWsDrop = dropTarget === folder.id;
              const isFolderDrop = folderDropTarget === folder.id;

              return (
                <div
                  key={folder.id}
                  className={`sidebar-folder${isFolderDrop ? ' sidebar-folder--drop-target' : ''}`}
                  draggable
                  onDragStart={(e) => handleFolderDragStart(e, folder.id)}
                  onDragEnd={handleFolderDragEnd}
                  onDragOver={(e) => {
                    handleDropZoneDragOver(e, folder.id);
                    handleFolderDragOver(e, folder.id);
                  }}
                  onDragLeave={(e) => {
                    handleDropZoneDragLeave(e, folder.id);
                    handleFolderDragLeave(e, folder.id);
                  }}
                  onDrop={(e) => {
                    // Workspace drop takes priority
                    if (e.dataTransfer.types.includes(WS_DRAG)) {
                      handleDropZoneDrop(e, folder.id);
                    } else if (e.dataTransfer.types.includes(FOLDER_DRAG)) {
                      handleFolderDrop(e, folder.id);
                    }
                  }}
                >
                  <div className="sidebar-folder-header">
                    {renamingFolderId === folder.id ? (
                      <input
                        ref={renameFolderInputRef}
                        className="sidebar-rename-input"
                        value={renameFolderValue}
                        onChange={(e) => setRenameFolderValue(e.target.value)}
                        onBlur={commitFolderRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') commitFolderRename();
                          if (e.key === 'Escape') cancelFolderRename();
                        }}
                      />
                    ) : (
                      <button
                        className="sidebar-folder-toggle"
                        onClick={() => onToggleFolder(folder.id)}
                        onDoubleClick={() => startFolderRename(folder)}
                        title="Click to toggle · Double-click to rename"
                      >
                        <span className={`sidebar-folder-chevron${isOpen ? ' sidebar-folder-chevron--open' : ''}`}>
                          <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                            <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                          </svg>
                        </span>
                        <span className="sidebar-folder-icon">
                          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
                            {isOpen ? (
                              <path d="M2 5.5A1.5 1.5 0 013.5 4H6l1.5 1.5h5A1.5 1.5 0 0114 7v4.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-6z" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="1.1" />
                            ) : (
                              <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.2" />
                            )}
                          </svg>
                        </span>
                        <span className="sidebar-folder-name">{folder.name}</span>
                      </button>
                    )}
                    {renamingFolderId !== folder.id && (
                      <button
                        className="sidebar-folder-delete"
                        onClick={() => onDeleteFolder(folder.id)}
                        title="Delete folder"
                      >
                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                        </svg>
                      </button>
                    )}
                  </div>

                  {/* Folder children */}
                  <div
                    className={`sidebar-folder-children${!isOpen ? ' sidebar-folder-children--collapsed' : ''}${isWsDrop ? ' sidebar-drop-zone--active' : ''}`}
                  >
                    {isOpen && folderWorkspaces.map(renderWorkspaceItem)}
                    {isOpen && folderWorkspaces.length === 0 && (
                      <div className="sidebar-folder-empty">Drop workspaces here</div>
                    )}
                  </div>
                </div>
              );
            })}

            {/* Root drop zone for un-foldered workspaces (shown below folders) */}
            <div
              className={`sidebar-list sidebar-drop-zone${dropTarget === '__root__' ? ' sidebar-drop-zone--active' : ''}`}
              onDragOver={(e) => handleDropZoneDragOver(e, '__root__')}
              onDragLeave={(e) => handleDropZoneDragLeave(e, '__root__')}
              onDrop={(e) => handleDropZoneDrop(e, undefined)}
            >
              {rootWorkspaces.map(renderWorkspaceItem)}
            </div>

            {/* Inline create input */}
            {inlineCreate && (
              <div className="sidebar-list">
                <div className="sidebar-inline-create">
                  <span className="sidebar-item-icon">
                    {inlineCreate === 'folder' ? (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.2" />
                      </svg>
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                        <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
                        <path d="M5 6h6M5 9h4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                      </svg>
                    )}
                  </span>
                  <input
                    ref={inlineCreateRef}
                    className="sidebar-rename-input sidebar-rename-input--new"
                    placeholder={inlineCreate === 'folder' ? 'Folder name…' : 'Workspace name…'}
                    value={inlineCreateValue}
                    onChange={(e) => setInlineCreateValue(e.target.value)}
                    onBlur={() => (inlineCreateValue.trim() ? commitInlineCreate() : cancelInlineCreate())}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitInlineCreate();
                      if (e.key === 'Escape') cancelInlineCreate();
                    }}
                  />
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {/* Layers panel — node tree in active workspace */}
      {!collapsed && activeNodes.length > 0 && (
        <div className="sidebar-layers">
          <div className="sidebar-section-header">
            <span className="sidebar-section-title">Layers</span>
            <span className="sidebar-layer-count">{activeNodes.length}</span>
          </div>
          <div className="sidebar-layers-scroll">
            {layerTree.map(({ node, children }) => {
              const isFrame = node.type === 'frame';
              const isOpen = isFrame && !collapsedLayers.has(node.id);
              return (
                <div key={node.id} className="sidebar-layer-group">
                  <button
                    className={`sidebar-layer-item${isFrame ? ' sidebar-layer-item--frame' : ''}`}
                    onClick={() => onNodeFocus?.(node.id)}
                    onContextMenu={(e) => handleLayerContextMenu(e, node.id)}
                    title={node.title}
                  >
                    {isFrame && (
                      <span
                        className={`sidebar-layer-chevron${isOpen ? ' sidebar-layer-chevron--open' : ''}`}
                        onClick={(e) => { e.stopPropagation(); toggleLayerCollapse(node.id); }}
                      >
                        <svg width="10" height="10" viewBox="0 0 16 16" fill="none">
                          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </span>
                    )}
                    <span className="sidebar-layer-icon">
                      {node.type === 'file' ? (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                          <path d="M4 2h5l3 3v9H4V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                          <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      ) : node.type === 'terminal' ? (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                          <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                          <path d="M5 7l2 1.5L5 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                          <path d="M9 10h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                        </svg>
                      ) : (
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                          <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2 2" />
                        </svg>
                      )}
                    </span>
                    <span className="sidebar-layer-name">
                      {node.type === 'frame' ? (node.title || (node.data as { label?: string }).label || 'Frame') : node.title}
                    </span>
                    {isFrame && children.length > 0 && (
                      <span className="sidebar-layer-child-count">{children.length}</span>
                    )}
                  </button>
                  {/* Children of frame */}
                  {isFrame && isOpen && children.length > 0 && (
                    <div className="sidebar-layer-children">
                      {children.map((child) => (
                        <button
                          key={child.id}
                          className="sidebar-layer-item"
                          onClick={() => onNodeFocus?.(child.id)}
                          onContextMenu={(e) => handleLayerContextMenu(e, child.id)}
                          title={child.title}
                        >
                          <span className="sidebar-layer-icon">
                            {child.type === 'file' ? (
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                <path d="M4 2h5l3 3v9H4V2z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round" />
                                <path d="M9 2v3h3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                              </svg>
                            ) : (
                              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                <rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
                                <path d="M5 7l2 1.5L5 10" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                                <path d="M9 10h2" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                              </svg>
                            )}
                          </span>
                          <span className="sidebar-layer-name">{child.title}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {!collapsed && (
        <div className="sidebar-install-section">
          <button
            className="sidebar-item sidebar-item--muted"
            onClick={handleInstallSkills}
            disabled={installStatus === 'installing'}
            title="Install canvas CLI and skills for agent discovery"
          >
            <span className="sidebar-item-icon">
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 2v8M5 7l3 3 3-3M3 12h10" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </span>
            <span className="sidebar-item-name">
              {installStatus === 'installing' ? 'Installing...' : 'Install for Agents'}
            </span>
          </button>
          {installMessage && (
            <div className="sidebar-install-message">{installMessage}</div>
          )}
        </div>
      )}

      {layerContextMenu && (
        <div
          className="sidebar-layer-context-menu"
          style={{ left: layerContextMenu.x, top: layerContextMenu.y }}
          onMouseDown={(e) => e.stopPropagation()}
          onContextMenu={(e) => e.preventDefault()}
        >
          <button
            className="sidebar-layer-context-menu-item sidebar-layer-context-menu-item--danger"
            onClick={() => {
              onNodeDelete?.(layerContextMenu.nodeId);
              setLayerContextMenu(null);
            }}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M3 4h10M6 4V2.5a1 1 0 011-1h2a1 1 0 011 1V4M5 4l.5 9a1 1 0 001 1h3a1 1 0 001-1L11 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <span>Delete</span>
          </button>
        </div>
      )}

      {collapsed && (
        <div className="sidebar-collapsed-toggle">
          <button className="sidebar-toggle" onClick={onToggle} title="Expand sidebar">
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
            </svg>
          </button>
        </div>
      )}
    </aside>
  );
};
