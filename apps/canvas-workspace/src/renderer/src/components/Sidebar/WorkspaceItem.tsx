import type React from 'react';
import type { WorkspaceEntry } from '../../hooks/useWorkspaces';
import { CloseIcon, ExportIcon, PencilIcon, WorkspaceIcon } from '../icons';

export interface WorkspaceItemProps {
  ws: WorkspaceEntry;
  activeId: string;
  activeView: string;
  isOnlyWorkspace: boolean;
  isRenaming: boolean;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement>;
  isDropBefore: boolean;
  onSelect: (id: string) => void;
  onStartRename: (ws: WorkspaceEntry) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelete: (id: string) => void;
  onExport: (id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onReorderDragOver: (e: React.DragEvent) => void;
  onReorderDragLeave: (e: React.DragEvent) => void;
  onReorderDrop: (e: React.DragEvent) => void;
}

export const WorkspaceItem = ({
  ws,
  activeId,
  activeView,
  isOnlyWorkspace,
  isRenaming,
  renameValue,
  renameInputRef,
  isDropBefore,
  onSelect,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onExport,
  onDragStart,
  onDragEnd,
  onReorderDragOver,
  onReorderDragLeave,
  onReorderDrop,
}: WorkspaceItemProps) => (
  <div
    className={`sidebar-workspace-entry${isDropBefore ? ' sidebar-workspace-entry--drop-before' : ''}`}
    draggable
    onDragStart={(e) => onDragStart(e, ws.id)}
    onDragEnd={onDragEnd}
    onDragOver={onReorderDragOver}
    onDragLeave={onReorderDragLeave}
    onDrop={onReorderDrop}
  >
    <div className="sidebar-item-row">
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className="sidebar-rename-input"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onRenameCommit();
            if (e.key === 'Escape') onRenameCancel();
          }}
        />
      ) : (
        <button
          className={`sidebar-item${activeId === ws.id && activeView === 'canvas' ? ' sidebar-item--active' : ''}`}
          onClick={() => onSelect(ws.id)}
          title={ws.name}
        >
          <span className="sidebar-item-icon">
            <WorkspaceIcon size={14} />
          </span>
          <span className="sidebar-item-name">{ws.name}</span>
        </button>
      )}
      {!isRenaming && (
        <button
          className="sidebar-item-rename"
          onClick={() => onStartRename(ws)}
          title="Rename"
          aria-label="Rename workspace"
        >
          <PencilIcon size={12} strokeWidth={1.4} />
        </button>
      )}
      {!isRenaming && (
        <button className="sidebar-item-export" onClick={() => onExport(ws.id)} title="Export workspace">
          <ExportIcon size={12} strokeWidth={1.5} />
        </button>
      )}
      {!isOnlyWorkspace && !isRenaming && (
        <button className="sidebar-item-delete" onClick={() => onDelete(ws.id)} title="Delete">
          <CloseIcon size={12} strokeWidth={1.5} />
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
