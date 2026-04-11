import type React from 'react';
import type { WorkspaceEntry } from '../../hooks/useWorkspaces';
import { CloseIcon, WorkspaceIcon } from '../icons';

export interface WorkspaceItemProps {
  ws: WorkspaceEntry;
  activeId: string;
  activeView: 'canvas' | 'chat';
  isOnlyWorkspace: boolean;
  isRenaming: boolean;
  renameValue: string;
  renameInputRef: React.RefObject<HTMLInputElement>;
  onSelect: (id: string) => void;
  onStartRename: (ws: WorkspaceEntry) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelete: (id: string) => void;
  onDragStart: (e: React.DragEvent, id: string) => void;
  onDragEnd: (e: React.DragEvent) => void;
}

export const WorkspaceItem = ({
  ws,
  activeId,
  activeView,
  isOnlyWorkspace,
  isRenaming,
  renameValue,
  renameInputRef,
  onSelect,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  onDragStart,
  onDragEnd,
}: WorkspaceItemProps) => (
  <div
    className="sidebar-workspace-entry"
    draggable
    onDragStart={(e) => onDragStart(e, ws.id)}
    onDragEnd={onDragEnd}
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
          className={`sidebar-item${activeId === ws.id && activeView !== 'chat' ? ' sidebar-item--active' : ''}`}
          onClick={() => onSelect(ws.id)}
          onDoubleClick={() => onStartRename(ws)}
          title="Double-click to rename"
        >
          <span className="sidebar-item-icon">
            <WorkspaceIcon size={14} />
          </span>
          <span className="sidebar-item-name">{ws.name}</span>
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
