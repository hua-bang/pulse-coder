import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import { useCanvas } from '../../hooks/useCanvas';
import { useNodes } from '../../hooks/useNodes';
import { useNodeDrag } from '../../hooks/useNodeDrag';
import { useNodeResize } from '../../hooks/useNodeResize';
import { useCanvasContext } from '../../hooks/useCanvasContext';
import { useCanvasFit } from '../../hooks/useCanvasFit';
import { useCanvasKeyboard } from '../../hooks/useCanvasKeyboard';
import type { CanvasNode } from '../../types';
import { CanvasNodeView } from '../CanvasNodeView';
import { NodeContextMenu } from '../NodeContextMenu';
import { FloatingToolbar } from '../FloatingToolbar';
import { ZoomIndicator } from '../ZoomIndicator';
import { SearchPalette } from '../SearchPalette';
import { CanvasEmptyHint } from '../CanvasEmptyHint';

export const Canvas = ({ canvasId, canvasName, rootFolder, hidden, onNodesChange, focusNodeId, onFocusComplete }: { canvasId: string; canvasName?: string; rootFolder?: string; hidden?: boolean; onNodesChange?: (canvasId: string, nodes: CanvasNode[]) => void; focusNodeId?: string; onFocusComplete?: () => void }) => {
  const [activeTool, setActiveTool] = useState('select');
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [clipboardNodes, setClipboardNodes] = useState<CanvasNode[]>([]);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasAutoFitted = useRef(false);
  const [contextMenu, setContextMenu] = useState<{
    screenX: number;
    screenY: number;
    canvasX: number;
    canvasY: number;
  } | null>(null);

  const containerRef = useRef<HTMLDivElement>(null);

  const {
    transform,
    setTransform,
    handleWheel,
    handleMouseDown: canvasMouseDown,
    handleMouseMove: canvasMouseMove,
    handleMouseUp: canvasMouseUp,
    screenToCanvas,
    resetTransform,
  } = useCanvas(activeTool === 'hand');

  const { animating, handleFocusNode, fitAllNodes } = useCanvasFit(containerRef, setTransform);

  const {
    nodes,
    loaded,
    addNode,
    updateNode,
    removeNode,
    removeNodes,
    moveNode,
    moveNodes,
    resizeNode,
    setTransformForSave,
    flushSave,
    commitHistory,
    undo,
    redo,
    duplicateNode,
    pasteNodes,
  } = useNodes(canvasId, () => {});

  // Flush pending saves on window close or component unmount
  useEffect(() => {
    const handler = () => { flushSave(); };
    window.addEventListener('beforeunload', handler);
    return () => {
      window.removeEventListener('beforeunload', handler);
      flushSave();
    };
  }, [flushSave]);

  // Only persist transform after data has loaded to avoid saving empty nodes
  useEffect(() => {
    if (!loaded) return;
    setTransformForSave(transform);
  }, [loaded, transform, setTransformForSave]);

  // Auto-fit all nodes into view on initial load
  useEffect(() => {
    if (loaded && !hasAutoFitted.current) {
      hasAutoFitted.current = true;
      if (nodes.length > 0) fitAllNodes(nodes);
    }
  }, [loaded, nodes, fitAllNodes]);

  // Report nodes to parent only after loaded
  useEffect(() => {
    if (!loaded) return;
    onNodesChange?.(canvasId, nodes);
  }, [canvasId, nodes, loaded, onNodesChange]);

  // Handle external focus request (e.g. from sidebar layers panel)
  useEffect(() => {
    if (!focusNodeId) return;
    const node = nodes.find((n) => n.id === focusNodeId);
    if (node) {
      setSelectedNodeIds([node.id]);
      setHighlightedId(node.id);
      handleFocusNode(node);
    }
    onFocusComplete?.();
  }, [focusNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

  useCanvasContext(rootFolder, nodes, canvasName);

  useCanvasKeyboard({
    undo, redo, nodes, selectedNodeIds, setSelectedNodeIds,
    duplicateNode, clipboardNodes, setClipboardNodes, pasteNodes, removeNodes,
    searchOpen, setSearchOpen, contextMenu, setContextMenu,
    setHighlightedId, handleFocusNode,
  });

  // Clear highlight after animation
  useEffect(() => {
    if (highlightedId) {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 1500);
    }
  }, [highlightedId]);

  const handleSearchSelect = useCallback((node: CanvasNode) => {
    setSelectedNodeIds([node.id]);
    setHighlightedId(node.id);
    handleFocusNode(node);
  }, [handleFocusNode]);

  const { draggingId, onDragStart, onDragMove, onDragEnd } = useNodeDrag(
    moveNode, moveNodes, transform.scale, nodes
  );
  const { resizingId, onResizeStart, onResizeMove, onResizeEnd } =
    useNodeResize(resizeNode, transform.scale);

  const isBlankCanvasTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return !target.closest('.canvas-node, .floating-toolbar, .zoom-indicator, .context-menu');
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!isBlankCanvasTarget(e.target)) return;
      if (!containerRef.current) return;
      const pos = screenToCanvas(e.clientX, e.clientY, containerRef.current);
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, canvasX: pos.x, canvasY: pos.y });
    },
    [isBlankCanvasTarget, screenToCanvas]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!isBlankCanvasTarget(e.target)) return;
      if (!containerRef.current) return;
      const pos = screenToCanvas(e.clientX, e.clientY, containerRef.current);
      setContextMenu({ screenX: e.clientX, screenY: e.clientY, canvasX: pos.x, canvasY: pos.y });
    },
    [isBlankCanvasTarget, screenToCanvas]
  );

  const handleCreateNode = useCallback(
    (type: 'file' | 'terminal' | 'frame') => {
      if (!contextMenu) return;
      const node = addNode(type, contextMenu.canvasX, contextMenu.canvasY);
      setSelectedNodeIds([node.id]);
      setContextMenu(null);
    },
    [addNode, contextMenu]
  );

  const handleToolbarAddNode = useCallback(
    (type: 'file' | 'terminal' | 'frame') => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pos = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2, containerRef.current);
      const halfW = type === 'file' ? 210 : type === 'terminal' ? 240 : 300;
      const node = addNode(type, pos.x - halfW, pos.y - (type === 'frame' ? 200 : 150));
      setSelectedNodeIds([node.id]);
    },
    [addNode, screenToCanvas]
  );

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (contextMenu) setContextMenu(null);
      if ((e.target as HTMLElement).closest('.canvas-node')) return;
      setSelectedNodeIds([]);
    },
    [contextMenu]
  );

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      canvasMouseMove(e);
      onDragMove(e);
      onResizeMove(e);
    },
    [canvasMouseMove, onDragMove, onResizeMove]
  );

  const handleMouseUp = useCallback(() => {
    canvasMouseUp();
    onDragEnd();
    onResizeEnd();
    commitHistory();
  }, [canvasMouseUp, onDragEnd, onResizeEnd, commitHistory]);

  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => {
      if (a.type === 'frame' && b.type !== 'frame') return -1;
      if (a.type !== 'frame' && b.type === 'frame') return 1;
      return 0;
    }),
    [nodes]
  );

  const cursorClass = activeTool === 'hand'
    ? ' canvas-container--hand'
    : resizingId ? ' canvas-container--resizing' : '';

  if (!loaded) {
    return (
      <div className="canvas-container">
        <div className="canvas-empty-hint">
          <div className="hint-text">Loading workspace...</div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`canvas-container${cursorClass}`}
      style={hidden ? { visibility: 'hidden', pointerEvents: 'none' } : undefined}
      onWheel={handleWheel}
      onMouseDown={canvasMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseUp}
      onDoubleClick={handleDoubleClick}
      onContextMenu={handleContextMenu}
      onClick={handleCanvasClick}
    >
      <div className="canvas-grid" />

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
            onDragStart={onDragStart}
            onResizeStart={onResizeStart}
            onUpdate={updateNode}
            onRemove={removeNode}
            onSelect={(id) => setSelectedNodeIds([id])}
            onFocus={handleFocusNode}
          />
        ))}
      </div>

      {nodes.length === 0 && !contextMenu && <CanvasEmptyHint />}

      {contextMenu && (
        <NodeContextMenu
          x={contextMenu.screenX}
          y={contextMenu.screenY}
          onCreate={handleCreateNode}
          onClose={() => setContextMenu(null)}
        />
      )}

      <FloatingToolbar
        activeTool={activeTool}
        onToolChange={setActiveTool}
        onAddNode={handleToolbarAddNode}
      />

      <ZoomIndicator scale={transform.scale} onReset={resetTransform} />

      {searchOpen && (
        <SearchPalette
          nodes={nodes}
          onSelect={handleSearchSelect}
          onClose={() => setSearchOpen(false)}
        />
      )}
    </div>
  );
};
