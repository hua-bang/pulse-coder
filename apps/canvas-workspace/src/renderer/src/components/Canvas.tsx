import { useCallback, useEffect, useRef, useState } from "react";
import { useCanvas } from "../hooks/useCanvas";
import { useNodes } from "../hooks/useNodes";
import { useNodeDrag } from "../hooks/useNodeDrag";
import { useNodeResize } from "../hooks/useNodeResize";
import { useCanvasContext } from "../hooks/useCanvasContext";
import type { CanvasNode, CanvasTransform } from "../types";
import { CanvasNodeView } from "./CanvasNodeView";
import { NodeContextMenu } from "./NodeContextMenu";
import { FloatingToolbar } from "./FloatingToolbar";
import { ZoomIndicator } from "./ZoomIndicator";
import { SearchPalette } from "./SearchPalette";

export const Canvas = ({ canvasId, canvasName, rootFolder, hidden }: { canvasId: string; canvasName?: string; rootFolder?: string; hidden?: boolean }) => {
  const [activeTool, setActiveTool] = useState("select");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [animating, setAnimating] = useState(false);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [highlightedId, setHighlightedId] = useState<string | null>(null);
  const highlightTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const {
    transform,
    setTransform,
    handleWheel,
    handleMouseDown: canvasMouseDown,
    handleMouseMove: canvasMouseMove,
    handleMouseUp: canvasMouseUp,
    screenToCanvas,
    resetTransform
  } = useCanvas(activeTool === "hand");

  const handleFocusNode = useCallback(
    (node: CanvasNode) => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const padding = 80;
      const fitScale = Math.min(
        (rect.width - padding * 2) / node.width,
        (rect.height - padding * 2) / node.height
      );
      const targetScale = Math.min(Math.max(0.1, fitScale), 1.5);
      const tx = rect.width / 2 - (node.x + node.width / 2) * targetScale;
      const ty = rect.height / 2 - (node.y + node.height / 2) * targetScale;

      setAnimating(true);
      setTransform({ x: tx, y: ty, scale: targetScale });
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      animTimerRef.current = setTimeout(() => setAnimating(false), 380);
    },
    [setTransform]
  );

  const handleRestoreTransform = useCallback(
    (t: CanvasTransform) => {
      setTransform(t);
    },
    [setTransform]
  );

  const {
    nodes,
    loaded,
    addNode,
    updateNode,
    removeNode,
    moveNode,
    resizeNode,
    setTransformForSave
  } = useNodes(canvasId, handleRestoreTransform);

  useEffect(() => {
    setTransformForSave(transform);
  }, [transform, setTransformForSave]);

  useCanvasContext(rootFolder, nodes, canvasName);

  // Cmd/Ctrl+K to open search
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        const activeEl = document.activeElement;
        const isEditable = activeEl && (
          activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          (activeEl as HTMLElement).isContentEditable
        );
        if (!isEditable) {
          e.preventDefault();
          setSearchOpen((prev) => !prev);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Clear highlight after animation
  useEffect(() => {
    if (highlightedId) {
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = setTimeout(() => setHighlightedId(null), 1500);
    }
  }, [highlightedId]);

  const handleSearchSelect = useCallback((node: CanvasNode) => {
    setSelectedNodeId(node.id);
    setHighlightedId(node.id);
    handleFocusNode(node);
  }, [handleFocusNode]);

  const { draggingId, onDragStart, onDragMove, onDragEnd } = useNodeDrag(
    moveNode,
    transform.scale
  );
  const { resizingId, onResizeStart, onResizeMove, onResizeEnd } =
    useNodeResize(resizeNode, transform.scale);

  const containerRef = useRef<HTMLDivElement>(null);

  const [contextMenu, setContextMenu] = useState<{
    screenX: number;
    screenY: number;
    canvasX: number;
    canvasY: number;
  } | null>(null);

  const isBlankCanvasTarget = useCallback((target: EventTarget | null) => {
    if (!(target instanceof HTMLElement)) return false;
    return !target.closest(
      ".canvas-node, .floating-toolbar, .zoom-indicator, .context-menu"
    );
  }, []);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      if (!isBlankCanvasTarget(e.target)) return;
      if (!containerRef.current) return;
      const pos = screenToCanvas(e.clientX, e.clientY, containerRef.current);
      setContextMenu({
        screenX: e.clientX,
        screenY: e.clientY,
        canvasX: pos.x,
        canvasY: pos.y
      });
    },
    [isBlankCanvasTarget, screenToCanvas]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent) => {
      if (!isBlankCanvasTarget(e.target)) return;
      if (!containerRef.current) return;
      const pos = screenToCanvas(e.clientX, e.clientY, containerRef.current);
      setContextMenu({
        screenX: e.clientX,
        screenY: e.clientY,
        canvasX: pos.x,
        canvasY: pos.y
      });
    },
    [isBlankCanvasTarget, screenToCanvas]
  );

  const handleCreateNode = useCallback(
    (type: "file" | "terminal") => {
      if (!contextMenu) return;
      const node = addNode(type, contextMenu.canvasX, contextMenu.canvasY);
      setSelectedNodeId(node.id);
      setContextMenu(null);
    },
    [addNode, contextMenu]
  );

  const handleToolbarAddNode = useCallback(
    (type: "file" | "terminal") => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const pos = screenToCanvas(
        rect.left + centerX,
        rect.top + centerY,
        containerRef.current
      );
      const node = addNode(
        type,
        pos.x - (type === "file" ? 210 : 240),
        pos.y - 150
      );
      setSelectedNodeId(node.id);
    },
    [addNode, screenToCanvas]
  );

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (contextMenu) setContextMenu(null);
      if ((e.target as HTMLElement).closest(".canvas-node")) return;
      setSelectedNodeId(null);
    },
    [contextMenu]
  );

  const handleNodeSelect = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
  }, []);



  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      canvasMouseDown(e);
    },
    [canvasMouseDown]
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
  }, [canvasMouseUp, onDragEnd, onResizeEnd]);

  const cursorClass =
    activeTool === "hand"
      ? " canvas-container--hand"
      : resizingId
        ? " canvas-container--resizing"
        : "";

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
      onMouseDown={handleMouseDown}
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
          transition: animating ? 'transform 0.32s cubic-bezier(0.25, 0.46, 0.45, 0.94)' : undefined
        }}
      >
        {nodes.map((node) => (
          <CanvasNodeView
            key={node.id}
            node={node}
            allNodes={nodes}
            rootFolder={rootFolder}
            workspaceId={canvasId}
            workspaceName={canvasName}
            isDragging={draggingId === node.id}
            isResizing={resizingId === node.id}
            isSelected={selectedNodeId === node.id}
            isHighlighted={highlightedId === node.id}
            onDragStart={onDragStart}
            onResizeStart={onResizeStart}
            onUpdate={updateNode}
            onRemove={removeNode}
            onSelect={handleNodeSelect}
            onFocus={handleFocusNode}
          />
        ))}
      </div>

      {nodes.length === 0 && !contextMenu && (
        <div className="canvas-empty-hint">
          <div className="hint-icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
              <rect
                x="4"
                y="4"
                width="16"
                height="16"
                rx="3"
                stroke="currentColor"
                strokeWidth="1.5"
              />
              <path
                d="M10 12h4M12 10v4"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
            </svg>
          </div>
          <div className="hint-text">
            Right-click or double-click to add a card
          </div>
          <div className="hint-sub">
            Scroll to pan &middot; Ctrl+Scroll to zoom
          </div>
        </div>
      )}

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
