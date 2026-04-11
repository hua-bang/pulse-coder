import type React from 'react';
import type { CanvasNode } from '../../types';
import { CanvasNodeView } from '../CanvasNodeView';
import type { ResizeEdge } from '../../hooks/useNodeResize';

interface CanvasSurfaceProps {
  transform: { x: number; y: number; scale: number };
  animating: boolean;
  sortedNodes: CanvasNode[];
  nodes: CanvasNode[];
  rootFolder?: string;
  canvasId: string;
  canvasName?: string;
  draggingId: string | null;
  resizingId: string | null;
  selectedNodeIds: string[];
  highlightedId: string | null;
  externallyEditedIds: Set<string>;
  onDragStart: (e: React.MouseEvent, node: CanvasNode) => void;
  onResizeStart: (e: React.MouseEvent, nodeId: string, width: number, height: number, edge: ResizeEdge) => void;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onFocus: (node: CanvasNode) => void;
}

export const CanvasSurface = ({
  transform,
  animating,
  sortedNodes,
  nodes,
  rootFolder,
  canvasId,
  canvasName,
  draggingId,
  resizingId,
  selectedNodeIds,
  highlightedId,
  externallyEditedIds,
  onDragStart,
  onResizeStart,
  onUpdate,
  onRemove,
  onSelect,
  onFocus,
}: CanvasSurfaceProps) => (
  <div
    className="canvas-transform"
    style={{
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
      '--canvas-scale': transform.scale,
      transition: animating
        ? 'transform 0.32s cubic-bezier(0.25, 0.46, 0.45, 0.94), --canvas-scale 0.32s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
        : undefined,
    } as React.CSSProperties}
  >
    {sortedNodes.map((node) => (
      <CanvasNodeView
        key={node.id}
        node={node}
        allNodes={nodes}
        rootFolder={rootFolder}
        workspaceId={canvasId}
        workspaceName={canvasName}
        isDragging={draggingId === node.id}
        isResizing={resizingId === node.id}
        isSelected={selectedNodeIds.includes(node.id)}
        isHighlighted={highlightedId === node.id}
        isAgentEdited={externallyEditedIds.has(node.id)}
        onDragStart={onDragStart}
        onResizeStart={onResizeStart}
        onUpdate={onUpdate}
        onRemove={onRemove}
        onSelect={onSelect}
        onFocus={onFocus}
      />
    ))}
  </div>
);
