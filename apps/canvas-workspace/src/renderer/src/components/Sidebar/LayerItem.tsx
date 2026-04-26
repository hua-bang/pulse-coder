import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import type { LayerTreeNode } from './utils/layers';
import { ChevronRightIcon, NodeTypeIcon } from '../icons';
import { getNodeDisplayLabel } from '../../utils/nodeLabel';

interface LayerItemProps {
  tree: LayerTreeNode;
  collapsedLayers: Set<string>;
  onFocus: (nodeId: string) => void;
  onContextMenu: (e: ReactMouseEvent, nodeId: string) => void;
  onToggleCollapse: (id: string) => void;
  renamingLayerId: string | null;
  renameLayerValue: string;
  renameLayerInputRef: RefObject<HTMLInputElement>;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}

export const LayerItem = ({
  tree,
  collapsedLayers,
  onFocus,
  onContextMenu,
  onToggleCollapse,
  renamingLayerId,
  renameLayerValue,
  renameLayerInputRef,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: LayerItemProps) => {
  const { node, children } = tree;
  const isFrame = node.type === 'frame';
  const isOpen = isFrame && !collapsedLayers.has(node.id);
  const isRenaming = renamingLayerId === node.id;
  const displayLabel = getNodeDisplayLabel(node);

  return (
    <div className="sidebar-layer-group">
      {isRenaming ? (
        <div className={`sidebar-layer-item sidebar-layer-item--editing${isFrame ? ' sidebar-layer-item--frame' : ''}`}>
          {isFrame ? (
            <span
              className={`sidebar-layer-chevron${isOpen ? ' sidebar-layer-chevron--open' : ''}`}
              onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.id); }}
            >
              <ChevronRightIcon size={10} />
            </span>
          ) : (
            <span className="sidebar-layer-spacer" aria-hidden="true" />
          )}
          <span className="sidebar-layer-icon">
            <NodeTypeIcon type={node.type} />
          </span>
          <input
            ref={renameLayerInputRef}
            className="sidebar-layer-rename-input"
            value={renameLayerValue}
            onChange={(event) => onRenameChange(event.target.value)}
            onBlur={onRenameCommit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') onRenameCommit();
              if (event.key === 'Escape') onRenameCancel();
            }}
            onMouseDown={(event) => event.stopPropagation()}
          />
        </div>
      ) : (
        <button
          className={`sidebar-layer-item${isFrame ? ' sidebar-layer-item--frame' : ''}`}
          onClick={() => onFocus(node.id)}
          onContextMenu={(e) => onContextMenu(e, node.id)}
          title={displayLabel}
        >
          {isFrame ? (
            <span
              className={`sidebar-layer-chevron${isOpen ? ' sidebar-layer-chevron--open' : ''}`}
              onClick={(e) => { e.stopPropagation(); onToggleCollapse(node.id); }}
            >
              <ChevronRightIcon size={10} />
            </span>
          ) : (
            <span className="sidebar-layer-spacer" aria-hidden="true" />
          )}
          <span className="sidebar-layer-icon">
            <NodeTypeIcon type={node.type} />
          </span>
          <span className="sidebar-layer-name">
            {node.type === 'frame'
              ? (node.title || (node.data as { label?: string }).label || 'Frame')
              : displayLabel}
          </span>
          {isFrame && children.length > 0 && (
            <span className="sidebar-layer-child-count">{children.length}</span>
          )}
        </button>
      )}

      {isFrame && children.length > 0 && (
        <div
          className={`sidebar-layer-children${!isOpen ? ' sidebar-layer-children--collapsed' : ''}`}
          aria-hidden={!isOpen}
        >
          <div className="sidebar-layer-children-inner">
            {children.map((child) => (
              <LayerItem
                key={child.node.id}
                tree={child}
                collapsedLayers={collapsedLayers}
                onFocus={onFocus}
                onContextMenu={onContextMenu}
                onToggleCollapse={onToggleCollapse}
                renamingLayerId={renamingLayerId}
                renameLayerValue={renameLayerValue}
                renameLayerInputRef={renameLayerInputRef}
                onRenameChange={onRenameChange}
                onRenameCommit={onRenameCommit}
                onRenameCancel={onRenameCancel}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
