import { useEffect, useRef, useState, useCallback, type DragEvent } from 'react';
import type { WorkspaceEntry, FolderEntry } from '../../hooks/useWorkspaces';

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
        <span className="sidebar-drag-handle" title="Drag to move">
          <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
            <circle cx="3" cy="3" r="1.2" fill="currentColor"/>
            <circle cx="7" cy="3" r="1.2" fill="currentColor"/>
            <circle cx="3" cy="7" r="1.2" fill="currentColor"/>
            <circle cx="7" cy="7" r="1.2" fill="currentColor"/>
            <circle cx="3" cy="11" r="1.2" fill="currentColor"/>
            <circle cx="7" cy="11" r="1.2" fill="currentColor"/>
          </svg>
        </span>
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
          {/* Section header with add button */}
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
            {/* Root drop zone for un-foldered workspaces */}
            <div
              className={`sidebar-list sidebar-drop-zone${dropTarget === '__root__' ? ' sidebar-drop-zone--active' : ''}`}
              onDragOver={(e) => handleDropZoneDragOver(e, '__root__')}
              onDragLeave={(e) => handleDropZoneDragLeave(e, '__root__')}
              onDrop={(e) => handleDropZoneDrop(e, undefined)}
            >
              {rootWorkspaces.map(renderWorkspaceItem)}
            </div>

            {/* Folders */}
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
                    <span className="sidebar-drag-handle" title="Drag to reorder">
                      <svg width="10" height="14" viewBox="0 0 10 14" fill="none">
                        <circle cx="3" cy="3" r="1.2" fill="currentColor"/>
                        <circle cx="7" cy="3" r="1.2" fill="currentColor"/>
                        <circle cx="3" cy="7" r="1.2" fill="currentColor"/>
                        <circle cx="7" cy="7" r="1.2" fill="currentColor"/>
                        <circle cx="3" cy="11" r="1.2" fill="currentColor"/>
                        <circle cx="7" cy="11" r="1.2" fill="currentColor"/>
                      </svg>
                    </span>
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
                          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            {isOpen ? (
                              <path d="M2 5.5A1.5 1.5 0 013.5 4H6l1.5 1.5h5A1.5 1.5 0 0114 7v4.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-6z" fill="currentColor" opacity="0.15" stroke="currentColor" strokeWidth="1.1" />
                            ) : (
                              <path d="M2 4.5A1.5 1.5 0 013.5 3H6l1.5 1.5h5A1.5 1.5 0 0114 6v5.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5v-7z" stroke="currentColor" strokeWidth="1.2" />
                            )}
                          </svg>
                        </span>
                        <span className="sidebar-folder-name">{folder.name}</span>
                        <span className="sidebar-folder-count">{folderWorkspaces.length}</span>
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

      <div className="sidebar-footer">
        <button className="sidebar-toggle" onClick={onToggle} title="Toggle sidebar">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d={collapsed ? 'M6 3l5 5-5 5' : 'M10 3L5 8l5 5'}
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>
    </aside>
  );
};
