import type React from 'react';
import type { CanvasNode } from '../../types';
import { NodeContextMenu } from '../NodeContextMenu';
import { FloatingToolbar } from '../FloatingToolbar';
import { ZoomIndicator } from '../ZoomIndicator';
import { SearchPalette } from '../SearchPalette';
import { CanvasEmptyHint } from '../CanvasEmptyHint';

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
