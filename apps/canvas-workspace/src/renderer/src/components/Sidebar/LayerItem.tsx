import type { MouseEvent as ReactMouseEvent } from 'react';
import type { CanvasNode } from '../../types';
import { ChevronRightIcon, NodeTypeIcon } from '../icons';

interface LayerItemProps {
  node: CanvasNode;
  children: CanvasNode[];
  isCollapsed: boolean;
  onFocus: (nodeId: string) => void;
  onContextMenu: (e: ReactMouseEvent, nodeId: string) => void;
  onToggleCollapse: (id: string) => void;
}

export const LayerItem = ({
  node,
  children,
  isCollapsed,
  onFocus,
  onContextMenu,
  onToggleCollapse,
}: LayerItemProps) => {
  const isFrame = node.type === 'frame';
  const isOpen = isFrame && !isCollapsed;

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
              <button
                key={child.id}
                className="sidebar-layer-item"
                onClick={() => onFocus(child.id)}
                onContextMenu={(e) => onContextMenu(e, child.id)}
                title={child.title}
              >
                <span className="sidebar-layer-icon">
                  <NodeTypeIcon type={child.type} />
                </span>
                <span className="sidebar-layer-name">{child.title}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
