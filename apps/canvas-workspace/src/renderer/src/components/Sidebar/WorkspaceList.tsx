import type React from 'react';
import type { WorkspaceEntry, FolderEntry } from '../../hooks/useWorkspaces';
import { FolderItem } from './FolderItem';
import { InlineCreateRow } from './InlineCreateRow';

interface WorkspaceListProps {
  folders: FolderEntry[];
  workspaces: WorkspaceEntry[];
  dropTarget: string | null;
  folderDropTarget: string | null;
  renamingFolderId: string | null;
  renameFolderValue: string;
  renameFolderInputRef: React.RefObject<HTMLInputElement>;
  inlineCreate: 'workspace' | 'folder' | null;
  inlineCreateValue: string;
  inlineCreateRef: React.RefObject<HTMLInputElement>;
  inlineCreateFolderId: string | null;
  onFolderDragStart: (e: React.DragEvent, folderId: string) => void;
  onFolderDragEnd: (e: React.DragEvent) => void;
  onFolderCombinedDragOver: (e: React.DragEvent, folderId: string) => void;
  onFolderCombinedDragLeave: (e: React.DragEvent, folderId: string) => void;
  onFolderCombinedDrop: (e: React.DragEvent, folderId: string) => void;
  onRootDragOver: (e: React.DragEvent) => void;
  onRootDragLeave: (e: React.DragEvent) => void;
  onRootDrop: (e: React.DragEvent) => void;
  onToggleFolder: (id: string) => void;
  onStartFolderRename: (folder: FolderEntry) => void;
  onFolderRenameChange: (value: string) => void;
  onFolderRenameCommit: () => void;
  onFolderRenameCancel: () => void;
  onDeleteFolder: (id: string) => void;
  onCreateWorkspaceInFolder: (folderId: string) => void;
  renderWorkspace: (ws: WorkspaceEntry) => React.ReactNode;
  onInlineCreateChange: (value: string) => void;
  onInlineCreateCommit: () => void;
  onInlineCreateCancel: () => void;
}

export const WorkspaceList = ({
  folders,
  workspaces,
  dropTarget,
  folderDropTarget,
  renamingFolderId,
  renameFolderValue,
  renameFolderInputRef,
  inlineCreate,
  inlineCreateValue,
  inlineCreateRef,
  inlineCreateFolderId,
  onFolderDragStart,
  onFolderDragEnd,
  onFolderCombinedDragOver,
  onFolderCombinedDragLeave,
  onFolderCombinedDrop,
  onRootDragOver,
  onRootDragLeave,
  onRootDrop,
  onToggleFolder,
  onStartFolderRename,
  onFolderRenameChange,
  onFolderRenameCommit,
  onFolderRenameCancel,
  onDeleteFolder,
  onCreateWorkspaceInFolder,
  renderWorkspace,
  onInlineCreateChange,
  onInlineCreateCommit,
  onInlineCreateCancel,
}: WorkspaceListProps) => {
  const rootWorkspaces = workspaces.filter((ws) => !ws.folderId);
  const showRootInlineCreate = !!inlineCreate && inlineCreateFolderId === null;

  return (
    <div className="sidebar-scroll">
      {folders.map((folder) => {
        const folderWorkspaces = workspaces.filter((ws) => ws.folderId === folder.id);
        const folderInlineCreate =
          inlineCreate === 'workspace' && inlineCreateFolderId === folder.id ? (
            <InlineCreateRow
              type="workspace"
              value={inlineCreateValue}
              inputRef={inlineCreateRef}
              onChange={onInlineCreateChange}
              onCommit={onInlineCreateCommit}
              onCancel={onInlineCreateCancel}
            />
          ) : null;
        return (
          <FolderItem
            key={folder.id}
            folder={folder}
            folderWorkspaces={folderWorkspaces}
            isRenaming={renamingFolderId === folder.id}
            renameValue={renameFolderValue}
            renameFolderInputRef={renameFolderInputRef}
            isWsDrop={dropTarget === folder.id}
            isFolderDrop={folderDropTarget === folder.id}
            onFolderDragStart={onFolderDragStart}
            onFolderDragEnd={onFolderDragEnd}
            onDragOver={(e) => onFolderCombinedDragOver(e, folder.id)}
            onDragLeave={(e) => onFolderCombinedDragLeave(e, folder.id)}
            onDrop={(e) => onFolderCombinedDrop(e, folder.id)}
            onToggle={() => onToggleFolder(folder.id)}
            onStartRename={() => onStartFolderRename(folder)}
            onRenameChange={onFolderRenameChange}
            onRenameCommit={onFolderRenameCommit}
            onRenameCancel={onFolderRenameCancel}
            onDelete={() => onDeleteFolder(folder.id)}
            onCreateWorkspace={() => onCreateWorkspaceInFolder(folder.id)}
            renderWorkspace={renderWorkspace}
            inlineCreateSlot={folderInlineCreate}
          />
        );
      })}

      <div
        className={`sidebar-list sidebar-drop-zone${dropTarget === '__root__' ? ' sidebar-drop-zone--active' : ''}`}
        onDragOver={onRootDragOver}
        onDragLeave={onRootDragLeave}
        onDrop={onRootDrop}
      >
        {rootWorkspaces.map(renderWorkspace)}
      </div>

      {showRootInlineCreate && inlineCreate && (
        <InlineCreateRow
          type={inlineCreate}
          value={inlineCreateValue}
          inputRef={inlineCreateRef}
          onChange={onInlineCreateChange}
          onCommit={onInlineCreateCommit}
          onCancel={onInlineCreateCancel}
        />
      )}
    </div>
  );
};
