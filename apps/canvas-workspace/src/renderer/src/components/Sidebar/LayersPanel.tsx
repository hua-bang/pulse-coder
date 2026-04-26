import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import type { LayerTreeNode } from './utils/layers';
import { LayerItem } from './LayerItem';

interface LayersPanelProps {
  layerTree: LayerTreeNode[];
  frameIds: string[];
  nodeCount: number;
  anyFrameExpanded: boolean;
  collapsedLayers: Set<string>;
  onNodeFocus: (nodeId: string) => void;
  onContextMenu: (e: ReactMouseEvent, nodeId: string) => void;
  onToggleCollapse: (id: string) => void;
  onToggleAll: () => void;
  renamingLayerId: string | null;
  renameLayerValue: string;
  renameLayerInputRef: RefObject<HTMLInputElement>;
  onLayerRenameChange: (value: string) => void;
  onLayerRenameCommit: () => void;
  onLayerRenameCancel: () => void;
}

export const LayersPanel = ({
  layerTree,
  frameIds,
  nodeCount,
  anyFrameExpanded,
  collapsedLayers,
  onNodeFocus,
  onContextMenu,
  onToggleCollapse,
  onToggleAll,
  renamingLayerId,
  renameLayerValue,
  renameLayerInputRef,
  onLayerRenameChange,
  onLayerRenameCommit,
  onLayerRenameCancel,
}: LayersPanelProps) => (
  <div className="sidebar-layers">
    <div className="sidebar-section-header">
      <span className="sidebar-section-title">Layers</span>
      <div className="sidebar-section-actions">
        <span className="sidebar-layer-count">{nodeCount}</span>
        {frameIds.length > 0 && (
          <button
            className="sidebar-section-btn"
            onClick={onToggleAll}
            title={anyFrameExpanded ? 'Collapse all frames' : 'Expand all frames'}
            aria-label={anyFrameExpanded ? 'Collapse all frames' : 'Expand all frames'}
          >
            {anyFrameExpanded ? (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 2l4 4 4-4M4 14l4-4 4 4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path
                  d="M4 6l4-4 4 4M4 10l4 4 4-4"
                  stroke="currentColor"
                  strokeWidth="1.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
    <div className="sidebar-layers-scroll">
      {layerTree.map((tree) => (
        <LayerItem
          key={tree.node.id}
          tree={tree}
          collapsedLayers={collapsedLayers}
          onFocus={onNodeFocus}
          onContextMenu={onContextMenu}
          onToggleCollapse={onToggleCollapse}
          renamingLayerId={renamingLayerId}
          renameLayerValue={renameLayerValue}
          renameLayerInputRef={renameLayerInputRef}
          onRenameChange={onLayerRenameChange}
          onRenameCommit={onLayerRenameCommit}
          onRenameCancel={onLayerRenameCancel}
        />
      ))}
    </div>
  </div>
);
