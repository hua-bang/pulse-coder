import type { MouseEvent as ReactMouseEvent } from 'react';
import type { LayerTreeNode } from './utils/layers';
import { ChevronRightIcon, NodeTypeIcon } from '../icons';

interface LayerItemProps {
  tree: LayerTreeNode;
  collapsedLayers: Set<string>;
  onFocus: (nodeId: string) => void;
  onContextMenu: (e: ReactMouseEvent, nodeId: string) => void;
  onToggleCollapse: (id: string) => void;
}

export const LayerItem = ({
  tree,
  collapsedLayers,
  onFocus,
  onContextMenu,
  onToggleCollapse,
}: LayerItemProps) => {
  const { node, children } = tree;
  const isFrame = node.type === 'frame';
  const isOpen = isFrame && !collapsedLayers.has(node.id);

  return (
    <div className="sidebar-layer-group">
      <button
        className={`sidebar-layer-item${isFrame ? ' sidebar-layer-item--frame' : ''}`}
        onClick={() => onFocus(node.id)}
        onContextMenu={(e) => onContextMenu(e, node.id)}
        title={node.title}
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
            : node.title}
        </span>
        {isFrame && children.length > 0 && (
          <span className="sidebar-layer-child-count">{children.length}</span>
        )}
      </button>

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
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
