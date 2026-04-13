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
import { computeFrameDepths } from '../../utils/frameHierarchy';
import { CanvasSurface } from './CanvasSurface';
import { CanvasOverlays } from './CanvasOverlays';

export const Canvas = ({ canvasId, canvasName, rootFolder, hidden, onNodesChange, focusNodeId, onFocusComplete, deleteNodeId, onDeleteComplete, chatPanelOpen, onChatToggle }: { canvasId: string; canvasName?: string; rootFolder?: string; hidden?: boolean; onNodesChange?: (canvasId: string, nodes: CanvasNode[]) => void; focusNodeId?: string; onFocusComplete?: () => void; deleteNodeId?: string; onDeleteComplete?: () => void; chatPanelOpen?: boolean; onChatToggle?: () => void }) => {
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
    externallyEditedIds,
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

  // Handle external delete request (e.g. from sidebar layers context menu)
  useEffect(() => {
    if (!deleteNodeId) return;
    if (nodes.some((n) => n.id === deleteNodeId)) {
      removeNode(deleteNodeId);
      setSelectedNodeIds((ids) => ids.filter((id) => id !== deleteNodeId));
    }
    onDeleteComplete?.();
  }, [deleteNodeId]); // eslint-disable-line react-hooks/exhaustive-deps

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

  const { draggingId, draggingIds, onDragStart, onDragMove, onDragEnd } = useNodeDrag(
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
    (type: 'file' | 'terminal' | 'frame' | 'agent') => {
      if (!contextMenu) return;
      const node = addNode(type, contextMenu.canvasX, contextMenu.canvasY);
      setSelectedNodeIds([node.id]);
      setContextMenu(null);
    },
    [addNode, contextMenu]
  );

  const handleToolbarAddNode = useCallback(
    (type: 'file' | 'terminal' | 'frame' | 'agent') => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pos = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2, containerRef.current);
      const halfW = type === 'file' ? 210 : type === 'terminal' ? 240 : type === 'agent' ? 260 : 300;
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
    () => {
      const depths = computeFrameDepths(nodes);
      return [...nodes].sort((a, b) => {
        // Non-frames always render in front of frames.
        if (a.type === 'frame' && b.type !== 'frame') return -1;
        if (a.type !== 'frame' && b.type === 'frame') return 1;
        // Among frames, shallower frames render first (i.e. behind deeper
        // frames), so a nested child frame paints on top of its parent.
        if (a.type === 'frame' && b.type === 'frame') {
          return (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0);
        }
        return 0;
      });
    },
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

      <CanvasSurface
        transform={transform}
        animating={animating}
        sortedNodes={sortedNodes}
        nodes={nodes}
        rootFolder={rootFolder}
        canvasId={canvasId}
        canvasName={canvasName}
        draggingId={draggingId}
        draggingIds={draggingIds}
        resizingId={resizingId}
        selectedNodeIds={selectedNodeIds}
        highlightedId={highlightedId}
        externallyEditedIds={externallyEditedIds}
        onDragStart={onDragStart}
        onResizeStart={onResizeStart}
        onUpdate={updateNode}
        onRemove={removeNode}
        onSelect={(id) => setSelectedNodeIds([id])}
        onFocus={handleFocusNode}
      />

      <CanvasOverlays
        nodes={nodes}
        contextMenu={contextMenu}
        searchOpen={searchOpen}
        activeTool={activeTool}
        scale={transform.scale}
        chatPanelOpen={chatPanelOpen}
        onChatToggle={onChatToggle}
        onCreateNode={handleCreateNode}
        onCloseContextMenu={() => setContextMenu(null)}
        onToolChange={setActiveTool}
        onAddNode={handleToolbarAddNode}
        onResetTransform={resetTransform}
        onSearchSelect={handleSearchSelect}
        onCloseSearch={() => setSearchOpen(false)}
      />
    </div>
  );
};
