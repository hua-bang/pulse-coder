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
  onCreateNode: (type: 'file' | 'terminal' | 'frame' | 'agent') => void;
  onCloseContextMenu: () => void;
  onToolChange: (tool: string) => void;
  onAddNode: (type: 'file' | 'terminal' | 'frame' | 'agent') => void;
  onResetTransform: () => void;
  onSearchSelect: (node: CanvasNode) => void;
  onCloseSearch: () => void;
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
