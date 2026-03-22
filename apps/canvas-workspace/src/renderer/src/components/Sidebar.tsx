import { useEffect, useRef, useState } from 'react';
import type { WorkspaceEntry } from '../hooks/useWorkspaces';

interface Props {
  collapsed: boolean;
  onToggle: () => void;
  workspaces: WorkspaceEntry[];
  activeId: string;
  onSelect: (id: string) => void;
  onCreate: (name: string) => void;
  onRename: (id: string, name: string) => void;
  onDelete: (id: string) => void;
  onSetRootFolder: (id: string, folderPath: string) => void;
}

export const Sidebar = ({
  collapsed,
  onToggle,
  workspaces,
  activeId,
  onSelect,
  onCreate,
  onRename,
  onDelete,
  onSetRootFolder,
}: Props) => {
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const newInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  useEffect(() => {
    if (creating && newInputRef.current) {
      newInputRef.current.focus();
    }
  }, [creating]);

  const startRename = (ws: WorkspaceEntry) => {
    setRenamingId(ws.id);
    setRenameValue(ws.name);
  };

  const commitRename = () => {
    if (renamingId) onRename(renamingId, renameValue);
    setRenamingId(null);
  };

  const cancelRename = () => setRenamingId(null);

  const commitCreate = () => {
    if (newName.trim()) onCreate(newName.trim());
    setNewName('');
    setCreating(false);
  };

  const cancelCreate = () => {
    setNewName('');
    setCreating(false);
  };

  const pickFolder = async (wsId: string) => {
    const api = window.canvasWorkspace?.dialog;
    if (!api) return;
    const result = await api.openFolder();
    if (result.ok && result.folderPath) {
      onSetRootFolder(wsId, result.folderPath);
    }
  };

  return (
    <aside className={`sidebar${collapsed ? ' sidebar--collapsed' : ''}`}>
      <div className="sidebar-header">
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

      {!collapsed && (
        <>
          <div className="sidebar-section-title">Workspaces</div>
          <div className="sidebar-list">
            {workspaces.map((ws) => (
              <div key={ws.id} className="sidebar-workspace-entry">
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
                          <rect
                            x="2"
                            y="2"
                            width="12"
                            height="12"
                            rx="2"
                            stroke="currentColor"
                            strokeWidth="1.3"
                          />
                          <path
                            d="M5 6h6M5 9h4"
                            stroke="currentColor"
                            strokeWidth="1.2"
                            strokeLinecap="round"
                          />
                        </svg>
                      </span>
                      <span className="sidebar-item-name">{ws.name}</span>
                    </button>
                  )}

                  {workspaces.length > 1 && renamingId !== ws.id && (
                    <button
                      className="sidebar-item-delete"
                      onClick={() => onDelete(ws.id)}
                      title="Delete workspace"
                    >
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path
                          d="M4 4l8 8M12 4l-8 8"
                          stroke="currentColor"
                          strokeWidth="1.5"
                          strokeLinecap="round"
                        />
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
            ))}

            {creating && (
              <div className="sidebar-item-row">
                <input
                  ref={newInputRef}
                  className="sidebar-rename-input sidebar-rename-input--new"
                  placeholder="Workspace name…"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  onBlur={() => (newName.trim() ? commitCreate() : cancelCreate())}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') commitCreate();
                    if (e.key === 'Escape') cancelCreate();
                  }}
                />
              </div>
            )}
          </div>

          <div className="sidebar-list" style={{ marginTop: 4 }}>
            <button
              className="sidebar-item sidebar-item--muted"
              onClick={() => setCreating(true)}
            >
              <span className="sidebar-item-icon">
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M8 3v10M3 8h10"
                    stroke="currentColor"
                    strokeWidth="1.5"
                    strokeLinecap="round"
                  />
                </svg>
              </span>
              <span className="sidebar-item-name">New Workspace</span>
            </button>
          </div>
        </>
      )}
    </aside>
  );
};
