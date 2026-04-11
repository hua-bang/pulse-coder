import type React from 'react';
import { PlusIcon, AvatarIcon, WorkspaceIcon, FolderIcon } from '../icons';

export const SidebarToggleIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none">
    <rect x="1.5" y="2.5" width="13" height="11" rx="2" stroke="currentColor" strokeWidth="1.3" />
    <path d="M6 2.5v11" stroke="currentColor" strokeWidth="1.3" />
  </svg>
);

interface SidebarHeaderProps {
  onToggle: () => void;
  activeView: 'canvas' | 'chat';
  onEnterChat: () => void;
  showAddMenu: boolean;
  onToggleAddMenu: () => void;
  addMenuRef: React.RefObject<HTMLDivElement>;
  onNewWorkspace: () => void;
  onNewFolder: () => void;
}

export const SidebarHeader = ({
  onToggle,
  activeView,
  onEnterChat,
  showAddMenu,
  onToggleAddMenu,
  addMenuRef,
  onNewWorkspace,
  onNewFolder,
}: SidebarHeaderProps) => (
  <>
    <div className="sidebar-brand-header">
      <span className="sidebar-brand-mark" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 512 512" fill="none">
          <rect x="32" y="32" width="448" height="448" rx="96" ry="96" fill="#FFFFFF" />
          <path
            d="M 80,268 H 188 L 228,178 L 260,370 L 292,148 L 328,268 H 432"
            stroke="#1D1D1F"
            strokeWidth="22"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      <span className="sidebar-brand">Pulse Canvas</span>
      <button className="sidebar-section-btn" onClick={onToggle} title="Collapse sidebar">
        <SidebarToggleIcon size={14} />
      </button>
    </div>

    <div className="sidebar-nav">
      <button
        className={`sidebar-nav-item${activeView === 'chat' ? ' sidebar-nav-item--active' : ''}`}
        onClick={onEnterChat}
        title="AI Chat page (⌘/Ctrl+Shift+L)"
      >
        <span className="sidebar-nav-icon">
          <AvatarIcon size={14} />
        </span>
        <span className="sidebar-nav-label">AI Chat</span>
      </button>
    </div>

    <div className="sidebar-section-header">
      <span className="sidebar-section-title">Workspaces</span>
      <div className="sidebar-section-actions" ref={addMenuRef}>
        <button
          className="sidebar-section-btn"
          onClick={onToggleAddMenu}
          title="Add workspace or folder"
        >
          <PlusIcon size={14} />
        </button>
        {showAddMenu && (
          <div className="sidebar-add-menu">
            <button
              className="sidebar-add-menu-item"
              onClick={onNewWorkspace}
            >
              <WorkspaceIcon size={14} />
              <span>New Workspace</span>
            </button>
            <button
              className="sidebar-add-menu-item"
              onClick={onNewFolder}
            >
              <FolderIcon size={14} />
              <span>New Folder</span>
            </button>
          </div>
        )}
      </div>
    </div>
  </>
);
