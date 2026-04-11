import type React from 'react';
import type { FolderEntry, WorkspaceEntry } from '../../hooks/useWorkspaces';
import { CloseIcon, ChevronRightIcon, FolderIcon } from '../icons';

interface FolderItemProps {
  folder: FolderEntry;
  folderWorkspaces: WorkspaceEntry[];
  isRenaming: boolean;
  renameValue: string;
  renameFolderInputRef: React.RefObject<HTMLInputElement>;
  isWsDrop: boolean;
  isFolderDrop: boolean;
  onFolderDragStart: (e: React.DragEvent, folderId: string) => void;
  onFolderDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  onToggle: () => void;
  onStartRename: () => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onDelete: () => void;
  renderWorkspace: (ws: WorkspaceEntry) => React.ReactNode;
}

export const FolderItem = ({
  folder,
  folderWorkspaces,
  isRenaming,
  renameValue,
  renameFolderInputRef,
  isWsDrop,
  isFolderDrop,
  onFolderDragStart,
  onFolderDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  onToggle,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onDelete,
  renderWorkspace,
}: FolderItemProps) => {
  const isOpen = !folder.collapsed;

  return (
    <div
      className={`sidebar-folder${isFolderDrop ? ' sidebar-folder--drop-target' : ''}`}
      draggable
      onDragStart={(e) => onFolderDragStart(e, folder.id)}
      onDragEnd={onFolderDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="sidebar-folder-header">
        {isRenaming ? (
          <input
            ref={renameFolderInputRef}
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
            className="sidebar-folder-toggle"
            onClick={onToggle}
            onDoubleClick={onStartRename}
            title="Click to toggle · Double-click to rename"
          >
            <span className={`sidebar-folder-chevron${isOpen ? ' sidebar-folder-chevron--open' : ''}`}>
              <ChevronRightIcon size={10} />
            </span>
            <span className="sidebar-folder-icon">
              <FolderIcon size={14} open={isOpen} strokeWidth={isOpen ? 1.1 : 1.2} />
            </span>
            <span className="sidebar-folder-name">{folder.name}</span>
          </button>
        )}
        {!isRenaming && (
          <button
            className="sidebar-folder-delete"
            onClick={onDelete}
            title="Delete folder"
          >
            <CloseIcon size={12} strokeWidth={1.5} />
          </button>
        )}
      </div>

      <div
        className={`sidebar-folder-children${!isOpen ? ' sidebar-folder-children--collapsed' : ''}${isWsDrop ? ' sidebar-drop-zone--active' : ''}`}
        aria-hidden={!isOpen}
      >
        <div className="sidebar-folder-children-inner">
          {folderWorkspaces.map(renderWorkspace)}
          {folderWorkspaces.length === 0 && (
            <div className="sidebar-folder-empty">Drop workspaces here</div>
          )}
        </div>
      </div>
    </div>
  );
};
