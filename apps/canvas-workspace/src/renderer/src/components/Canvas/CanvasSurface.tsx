import type React from 'react';
import type { CanvasEdge, CanvasNode } from '../../types';
import { CanvasNodeView } from '../CanvasNodeView';
import { CanvasEdgesLayer } from '../CanvasEdgesLayer';
import type { ResizeEdge } from '../../hooks/useNodeResize';
import type { EdgeInteractionState, Point } from '../../hooks/useEdgeInteraction';

interface CanvasSurfaceProps {
  transform: { x: number; y: number; scale: number };
  animating: boolean;
  /** True while the user is actively panning/zooming. Drives conditional
   *  `will-change: transform` so the canvas subtree is only promoted to
   *  its own compositor layer while it's actually moving — avoiding the
   *  permanent tile-memory cost that otherwise trips Chromium's
   *  "tile memory limits exceeded" warning on canvases with many
   *  (especially nested) frames. */
  moving: boolean;
  sortedNodes: CanvasNode[];
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  rootFolder?: string;
  canvasId: string;
  canvasName?: string;
  draggingId: string | null;
  /** Every node participating in the current drag — includes descendants of a
   *  dragged frame so the full group can share the lifted stacking context. */
  draggingIds: Set<string>;
  resizingId: string | null;
  selectedNodeIds: string[];
  selectedEdgeId: string | null;
  highlightedId: string | null;
  externallyEditedIds: Set<string>;
  /** Live edge interaction state — passed straight to the edges layer so it
   *  can render the preview / highlight the hover target. */
  edgeInteractionState: EdgeInteractionState | null;
  /** Preview endpoints resolved by the interaction hook. Null when no
   *  connect/move-end drag is in flight. */
  edgePreviewEndpoints: { s: Point; t: Point } | null;
  onDragStart: (e: React.MouseEvent, node: CanvasNode) => void;
  onResizeStart: (
    e: React.MouseEvent,
    nodeId: string,
    width: number,
    height: number,
    edge: ResizeEdge,
    minWidth?: number,
    minHeight?: number
  ) => void;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onFocus: (node: CanvasNode) => void;
  onSelectEdge: (id: string | null) => void;
  onEdgeHandleMouseDown: (
    edgeId: string,
    handle: 'source' | 'target' | 'bend',
    e: React.MouseEvent,
    ctx: { s: Point; t: Point },
  ) => void;
  /** Mousedown on the edge body (not a handle). Starts a "translate
   *  the whole edge" drag. */
  onEdgeBodyMouseDown: (edgeId: string, e: React.MouseEvent) => void;
  /** Double-click on the edge body. Opens the edge-label editor. */
  onEdgeBodyDoubleClick: (edgeId: string, e: React.MouseEvent) => void;
}

export const CanvasSurface = ({
  transform,
  animating,
  moving,
  sortedNodes,
  nodes,
  edges,
  rootFolder,
  canvasId,
  canvasName,
  draggingId,
  draggingIds,
  resizingId,
  selectedNodeIds,
  selectedEdgeId,
  highlightedId,
  externallyEditedIds,
  edgeInteractionState,
  edgePreviewEndpoints,
  onDragStart,
  onResizeStart,
  onUpdate,
  onRemove,
  onSelect,
  onFocus,
  onSelectEdge,
  onEdgeHandleMouseDown,
  onEdgeBodyMouseDown,
  onEdgeBodyDoubleClick,
}: CanvasSurfaceProps) => (
  <div
    className={`canvas-transform${moving || animating ? ' canvas-transform--moving' : ''}`}
    style={{
      transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`,
      '--canvas-scale': transform.scale,
      transition: animating
        ? 'transform 0.32s cubic-bezier(0.25, 0.46, 0.45, 0.94), --canvas-scale 0.32s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
        : undefined,
    } as React.CSSProperties}
  >
    {/* Edges render beneath nodes so node interactions keep working and
        so the connection line visually terminates behind the node it
        points at rather than being covered by it. */}
    <CanvasEdgesLayer
      edges={edges}
      nodes={nodes}
      selectedEdgeId={selectedEdgeId}
      onSelectEdge={onSelectEdge}
      interactionState={edgeInteractionState}
      previewEndpoints={edgePreviewEndpoints}
      onHandleMouseDown={onEdgeHandleMouseDown}
      onBodyMouseDown={onEdgeBodyMouseDown}
      onBodyDoubleClick={onEdgeBodyDoubleClick}
    />
    {sortedNodes.map((node) => (
      <CanvasNodeView
        key={node.id}
        node={node}
        allNodes={nodes}
        rootFolder={rootFolder}
        workspaceId={canvasId}
        workspaceName={canvasName}
        isDragging={draggingIds.has(node.id) || draggingId === node.id}
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
