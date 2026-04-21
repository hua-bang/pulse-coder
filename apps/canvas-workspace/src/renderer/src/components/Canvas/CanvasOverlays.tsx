import type React from 'react';
import type { CanvasEdge, CanvasNode, CanvasTransform } from '../../types';
import { NodeContextMenu } from '../NodeContextMenu';
import { FloatingToolbar } from '../FloatingToolbar';
import { ZoomIndicator } from '../ZoomIndicator';
import { SearchPalette } from '../SearchPalette';
import { CanvasEmptyHint } from '../CanvasEmptyHint';
import { EdgeStylePanel } from '../EdgeStylePanel';
import { EdgeLabel } from '../EdgeLabel';

interface CanvasOverlaysProps {
  nodes: CanvasNode[];
  contextMenu: {
    screenX: number;
    screenY: number;
    canvasX: number;
    canvasY: number;
  } | null;
  searchOpen: boolean;
  activeTool: string;
  scale: number;
  chatPanelOpen?: boolean;
  onChatToggle?: () => void;
  onCreateNode: (type: 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe' | 'mindmap') => void;
  onCloseContextMenu: () => void;
  onToolChange: (tool: string) => void;
  onAddNode: (type: 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe' | 'mindmap') => void;
  onResetTransform: () => void;
  onSearchSelect: (node: CanvasNode) => void;
  onCloseSearch: () => void;
  /** Mousedown handler for the connect-mode overlay. Wired by the
   *  parent Canvas component to the edge interaction hook. */
  onConnectMouseDown?: (e: React.MouseEvent) => void;
  /** True whenever the user has picked one of the shape-draw tools
   *  (shape-rect / shape-ellipse). Drives the draw overlay. */
  shapeToolActive?: boolean;
  /** Mousedown handler for the shape-draw overlay. */
  onShapeMouseDown?: (e: React.MouseEvent) => void;
  /** Currently-selected edge (full object) — null when none or the
   *  selection refers to a node. The overlays layer uses it to render
   *  the floating EdgeStylePanel. */
  selectedEdge?: CanvasEdge | null;
  /** Canvas transform, needed by EdgeStylePanel to project the edge
   *  midpoint from canvas space to screen space. */
  transform: CanvasTransform;
  onUpdateEdge?: (id: string, patch: Partial<CanvasEdge>) => void;
  onRemoveEdge?: (id: string) => void;
  /** All edges — needed for label rendering. Labels render as DOM
   *  overlay elements (outside .canvas-transform) so text stays crisp
   *  and editable regardless of zoom. */
  edges?: CanvasEdge[];
  /** Id of the edge whose label is currently in edit mode, or null. */
  editingEdgeLabelId?: string | null;
  onStartEditEdgeLabel?: (id: string) => void;
  onCommitEditEdgeLabel?: (id: string, label: string) => void;
  onCancelEditEdgeLabel?: () => void;
}

export const CanvasOverlays = ({
  nodes,
  contextMenu,
  searchOpen,
  activeTool,
  scale,
  chatPanelOpen,
  onChatToggle,
  onCreateNode,
  onCloseContextMenu,
  onToolChange,
  onAddNode,
  onResetTransform,
  onSearchSelect,
  onCloseSearch,
  onConnectMouseDown,
  shapeToolActive,
  onShapeMouseDown,
  selectedEdge,
  transform,
  onUpdateEdge,
  onRemoveEdge,
  edges,
  editingEdgeLabelId,
  onStartEditEdgeLabel,
  onCommitEditEdgeLabel,
  onCancelEditEdgeLabel,
}: CanvasOverlaysProps) => (
  <>
    {nodes.length === 0 && !contextMenu && <CanvasEmptyHint />}

    {contextMenu && (
      <NodeContextMenu
        x={contextMenu.screenX}
        y={contextMenu.screenY}
        onCreate={onCreateNode}
        onClose={onCloseContextMenu}
      />
    )}

    {/* Full-canvas overlay active only in Connect mode. It intercepts
        pointer events above nodes so mousedown on any location — node
        or blank — begins an edge draft instead of a node drag. The
        FloatingToolbar renders AFTER this element and has its own
        position/z-index, so mode switching still works while this is
        mounted. */}
    {activeTool === 'connect' && (
      <div
        className="canvas-connect-overlay"
        style={{
          position: 'absolute',
          inset: 0,
          cursor: 'crosshair',
          // Slightly below the zero-indexed floating toolbar
          // (`.floating-toolbar` has its own z-index for chrome) but
          // above nodes inside `.canvas-transform`.
          zIndex: 5,
        }}
        onMouseDown={onConnectMouseDown}
      />
    )}

    {/* Drag-to-draw overlay for shape tools. Same layering trick as the
        connect overlay so a drag that starts over an existing node still
        creates a shape rather than selecting the node underneath. */}
    {shapeToolActive && (
      <div
        className="canvas-shape-overlay"
        style={{
          position: 'absolute',
          inset: 0,
          cursor: 'crosshair',
          zIndex: 5,
        }}
        onMouseDown={onShapeMouseDown}
      />
    )}

    <FloatingToolbar
      activeTool={activeTool}
      onToolChange={onToolChange}
      onAddNode={onAddNode}
      chatPanelOpen={chatPanelOpen}
      onChatToggle={onChatToggle}
    />

    {selectedEdge && onUpdateEdge && onRemoveEdge && (
      <EdgeStylePanel
        edge={selectedEdge}
        nodes={nodes}
        transform={transform}
        onUpdate={onUpdateEdge}
        onRemove={onRemoveEdge}
      />
    )}

    {/* Edge labels. Rendered for every edge that either carries a
        non-empty label or is currently in edit mode. The edit-mode check
        lets us open the input on a freshly-dbl-clicked unlabeled edge
        without first persisting an empty string. */}
    {edges && onStartEditEdgeLabel && onCommitEditEdgeLabel && onCancelEditEdgeLabel &&
      edges
        .filter((edge) => (edge.label && edge.label.length > 0) || editingEdgeLabelId === edge.id)
        .map((edge) => (
          <EdgeLabel
            key={edge.id}
            edge={edge}
            nodes={nodes}
            transform={transform}
            isEditing={editingEdgeLabelId === edge.id}
            onStartEdit={onStartEditEdgeLabel}
            onCommit={onCommitEditEdgeLabel}
            onCancel={onCancelEditEdgeLabel}
          />
        ))}

    <ZoomIndicator scale={scale} onReset={onResetTransform} />

    {searchOpen && (
      <SearchPalette
        nodes={nodes}
        onSelect={onSearchSelect}
        onClose={onCloseSearch}
      />
    )}
  </>
);
