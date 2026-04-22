import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import { useCanvas } from '../../hooks/useCanvas';
import { useNodes } from '../../hooks/useNodes';
import { useNodeDrag } from '../../hooks/useNodeDrag';
import { useNodeResize } from '../../hooks/useNodeResize';
import { useCanvasContext } from '../../hooks/useCanvasContext';
import { useCanvasFit } from '../../hooks/useCanvasFit';
import { useCanvasKeyboard } from '../../hooks/useCanvasKeyboard';
import { useCanvasImagePaste } from '../../hooks/useCanvasImagePaste';
import { useEdgeInteraction } from '../../hooks/useEdgeInteraction';
import { useShapeDraw } from '../../hooks/useShapeDraw';
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
    moving,
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
    edges,
    loaded,
    externallyEditedIds,
    addNode,
    updateNode,
    removeNode,
    removeNodes,
    moveNode,
    moveNodes,
    resizeNode,
    addEdge,
    updateEdge,
    removeEdge,
    setTransformForSave,
    flushSave,
    commitHistory,
    undo,
    redo,
    duplicateNode,
    pasteNodes,
  } = useNodes(canvasId, () => {});

  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  // Which edge (if any) is in label-edit mode. Driven by dbl-click on
  // the edge body; cleared on blur/Escape/Enter. Stored here (not inside
  // EdgeLabel) so that selecting a different edge or deleting the edge
  // can forcibly end the edit session.
  const [editingEdgeLabelId, setEditingEdgeLabelId] = useState<string | null>(null);

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
    selectedEdgeId, setSelectedEdgeId, removeEdge,
    duplicateNode, clipboardNodes, setClipboardNodes, pasteNodes, removeNodes,
    searchOpen, setSearchOpen, contextMenu, setContextMenu,
    setHighlightedId, handleFocusNode,
  });

  useCanvasImagePaste({
    canvasId,
    active: !hidden,
    containerRef,
    screenToCanvas,
    addNode,
    updateNode,
    onCreated: (node) => setSelectedNodeIds([node.id]),
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

  // sortedNodes is the render order (frames first, non-frames on top,
  // deeper frames over shallower). It doubles as the hit-test stack
  // for edge interactions — we iterate it in reverse so the topmost
  // node under the cursor wins.
  const sortedNodes = useMemo(
    () => {
      const depths = computeFrameDepths(nodes);
      return [...nodes].sort((a, b) => {
        if (a.type === 'frame' && b.type !== 'frame') return -1;
        if (a.type !== 'frame' && b.type === 'frame') return 1;
        if (a.type === 'frame' && b.type === 'frame') {
          return (depths.get(a.id) ?? 0) - (depths.get(b.id) ?? 0);
        }
        return 0;
      });
    },
    [nodes]
  );

  const getContainer = useCallback(() => containerRef.current, []);

  const {
    state: edgeInteractionState,
    beginConnect,
    beginMoveEnd,
    beginMoveBend,
    beginMoveEdge,
    getPreviewEndpoints,
  } = useEdgeInteraction({
    nodes,
    sortedNodes,
    screenToCanvas,
    getContainer,
    addEdge,
    updateEdge,
    commitHistory,
    edges,
    // After the user commits one arrow, hop back to the select tool and
    // auto-select the new edge so the style panel is immediately
    // available. Matches tldraw's "draw one arrow, then edit" flow and
    // fixes the "cursor is still in connect mode, hard to adjust the
    // nodes around it" feedback.
    onConnectCommitted: (edgeId) => {
      setActiveTool('select');
      setSelectedEdgeId(edgeId);
      setSelectedNodeIds([]);
    },
  });

  const handleEdgeHandleMouseDown = useCallback(
    (
      edgeId: string,
      handle: 'source' | 'target' | 'bend',
      e: React.MouseEvent,
      ctx: { s: { x: number; y: number }; t: { x: number; y: number } },
    ) => {
      if (handle === 'bend') {
        beginMoveBend(edgeId, ctx.s, ctx.t, e.clientX, e.clientY);
      } else {
        beginMoveEnd(edgeId, handle, e.clientX, e.clientY);
      }
    },
    [beginMoveBend, beginMoveEnd],
  );

  const handleConnectOverlayMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      e.preventDefault();
      beginConnect(e.clientX, e.clientY);
    },
    [beginConnect],
  );

  const {
    draft: shapeDraft,
    handleOverlayMouseDown: handleShapeOverlayMouseDown,
    isActive: shapeToolActive,
  } = useShapeDraw({
    activeTool,
    screenToCanvas,
    getContainer,
    addNode,
    updateNode,
    // Drop back to the select tool and select the committed shape so the
    // user can immediately restyle it via the ShapeStylePicker.
    onCommitted: (node) => {
      setActiveTool('select');
      setSelectedNodeIds([node.id]);
      setSelectedEdgeId(null);
    },
  });

  const handleEdgeBodyMouseDown = useCallback(
    (edgeId: string, e: React.MouseEvent) => {
      if (e.button !== 0) return;
      beginMoveEdge(edgeId, e.clientX, e.clientY);
    },
    [beginMoveEdge],
  );

  const handleEdgeBodyDoubleClick = useCallback(
    (edgeId: string) => {
      // Ensure the edge is selected before editing so the style panel
      // stays in sync with the edge the user is labeling.
      setSelectedEdgeId(edgeId);
      setSelectedNodeIds([]);
      setEditingEdgeLabelId(edgeId);
    },
    [],
  );

  const handleCommitEditEdgeLabel = useCallback(
    (edgeId: string, label: string) => {
      // Normalize: empty or whitespace-only labels clear the field back
      // to `undefined`, keeping the stored data clean (and making the
      // label chip disappear from the overlay).
      const trimmed = label.trim();
      updateEdge(edgeId, { label: trimmed.length > 0 ? trimmed : undefined });
      setEditingEdgeLabelId(null);
    },
    [updateEdge],
  );

  const handleCancelEditEdgeLabel = useCallback(() => {
    setEditingEdgeLabelId(null);
  }, []);

  const isBlankCanvasTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return !target.closest(
      '.canvas-node, .floating-toolbar, .zoom-indicator, .context-menu, .canvas-edges, .canvas-connect-overlay, .canvas-shape-overlay, .edge-style-panel',
    );
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
    (type: 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe' | 'mindmap') => {
      if (!contextMenu) return;
      const node = addNode(type, contextMenu.canvasX, contextMenu.canvasY);
      setSelectedNodeIds([node.id]);
      setContextMenu(null);
    },
    [addNode, contextMenu]
  );

  const handleToolbarAddNode = useCallback(
    (type: 'file' | 'terminal' | 'frame' | 'agent' | 'text' | 'iframe' | 'mindmap') => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pos = screenToCanvas(rect.left + rect.width / 2, rect.top + rect.height / 2, containerRef.current);
      const halfW =
        type === 'file' ? 210
        : type === 'terminal' ? 240
        : type === 'agent' ? 260
        : type === 'text' ? 130
        : type === 'iframe' ? 260
        : type === 'mindmap' ? 320
        : 300;
      const halfH =
        type === 'frame' ? 200
        : type === 'text' ? 60
        : type === 'iframe' ? 200
        : type === 'mindmap' ? 210
        : 150;
      const node = addNode(type, pos.x - halfW, pos.y - halfH);
      setSelectedNodeIds([node.id]);
    },
    [addNode, screenToCanvas]
  );

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (contextMenu) setContextMenu(null);
      const target = e.target as HTMLElement;
      if (target.closest('.canvas-node')) return;
      // Clicking inside the edges SVG (either a hit-proxy or a handle)
      // lands on a child of .canvas-edges. Those children stopPropagate
      // their own onMouseDown, but the click event can still arrive
      // here — ignore it so we don't wipe the selection we just set.
      if (target.closest('.canvas-edges')) return;
      // EdgeStylePanel clicks already stopPropagation in its own handlers,
      // but this belt-and-braces check covers any edge cases where an
      // internal button relies on default bubbling.
      if (target.closest('.edge-style-panel')) return;
      setSelectedNodeIds([]);
      setSelectedEdgeId(null);
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

  const cursorClass = activeTool === 'hand'
    ? ' canvas-container--hand'
    : shapeToolActive ? ' canvas-container--shape'
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
        moving={moving}
        sortedNodes={sortedNodes}
        nodes={nodes}
        edges={edges}
        rootFolder={rootFolder}
        canvasId={canvasId}
        canvasName={canvasName}
        draggingId={draggingId}
        draggingIds={draggingIds}
        resizingId={resizingId}
        selectedNodeIds={selectedNodeIds}
        selectedEdgeId={selectedEdgeId}
        highlightedId={highlightedId}
        externallyEditedIds={externallyEditedIds}
        edgeInteractionState={edgeInteractionState}
        edgePreviewEndpoints={getPreviewEndpoints()}
        shapeDraft={shapeDraft}
        onDragStart={onDragStart}
        onResizeStart={onResizeStart}
        onUpdate={updateNode}
        onAutoResize={resizeNode}
        onRemove={removeNode}
        onSelect={(id) => {
          setSelectedNodeIds([id]);
          setSelectedEdgeId(null);
        }}
        onFocus={handleFocusNode}
        onSelectEdge={(id) => {
          setSelectedEdgeId(id);
          if (id) setSelectedNodeIds([]);
        }}
        onEdgeHandleMouseDown={handleEdgeHandleMouseDown}
        onEdgeBodyMouseDown={handleEdgeBodyMouseDown}
        onEdgeBodyDoubleClick={handleEdgeBodyDoubleClick}
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
        onConnectMouseDown={handleConnectOverlayMouseDown}
        shapeToolActive={shapeToolActive}
        onShapeMouseDown={handleShapeOverlayMouseDown}
        selectedEdge={edges.find((e) => e.id === selectedEdgeId) ?? null}
        transform={transform}
        onUpdateEdge={(id, patch) => {
          // Style mutations are single-step edits; commit to history
          // by default so undo reverses one color/width change at a time.
          updateEdge(id, patch);
        }}
        onRemoveEdge={(id) => {
          removeEdge(id);
          setSelectedEdgeId(null);
          if (editingEdgeLabelId === id) setEditingEdgeLabelId(null);
        }}
        edges={edges}
        editingEdgeLabelId={editingEdgeLabelId}
        onStartEditEdgeLabel={handleEdgeBodyDoubleClick}
        onCommitEditEdgeLabel={handleCommitEditEdgeLabel}
        onCancelEditEdgeLabel={handleCancelEditEdgeLabel}
      />
    </div>
  );
};
