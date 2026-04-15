import type React from 'react';
import type { CanvasEdge, CanvasNode, CanvasTransform } from '../../types';
import { NodeContextMenu } from '../NodeContextMenu';
import { FloatingToolbar } from '../FloatingToolbar';
import { ZoomIndicator } from '../ZoomIndicator';
import { SearchPalette } from '../SearchPalette';
import { CanvasEmptyHint } from '../CanvasEmptyHint';
import { EdgeStylePanel } from '../EdgeStylePanel';

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
  onCreateNode: (type: 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe') => void;
  onCloseContextMenu: () => void;
  onToolChange: (tool: string) => void;
  onAddNode: (type: 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe') => void;
  onResetTransform: () => void;
  onSearchSelect: (node: CanvasNode) => void;
  onCloseSearch: () => void;
  /** Mousedown handler for the connect-mode overlay. Wired by the
   *  parent Canvas component to the edge interaction hook. */
  onConnectMouseDown?: (e: React.MouseEvent) => void;
  /** Currently-selected edge (full object) — null when none or the
   *  selection refers to a node. The overlays layer uses it to render
   *  the floating EdgeStylePanel. */
  selectedEdge?: CanvasEdge | null;
  /** Canvas transform, needed by EdgeStylePanel to project the edge
   *  midpoint from canvas space to screen space. */
  transform: CanvasTransform;
  onUpdateEdge?: (id: string, patch: Partial<CanvasEdge>) => void;
  onRemoveEdge?: (id: string) => void;
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
  selectedEdge,
  transform,
  onUpdateEdge,
  onRemoveEdge,
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
