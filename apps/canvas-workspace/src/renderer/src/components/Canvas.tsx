import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [selectedNodeIds, setSelectedNodeIds] = useState<string[]>([]);
  const [clipboardNodes, setClipboardNodes] = useState<CanvasNode[]>([]);
  const [animating, setAnimating] = useState(false);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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

  const fitAllNodes = useCallback(
    (nodeList: CanvasNode[]) => {
      if (!containerRef.current || nodeList.length === 0) return;
      const rect = containerRef.current.getBoundingClientRect();
      const padding = 80;
      const minX = Math.min(...nodeList.map((n) => n.x));
      const minY = Math.min(...nodeList.map((n) => n.y));
      const maxX = Math.max(...nodeList.map((n) => n.x + n.width));
      const maxY = Math.max(...nodeList.map((n) => n.y + n.height));
      const boundsW = maxX - minX;
      const boundsH = maxY - minY;
      if (boundsW === 0 || boundsH === 0) return;
      const fitScale = Math.min(
        (rect.width - padding * 2) / boundsW,
        (rect.height - padding * 2) / boundsH
      );
      const targetScale = Math.min(Math.max(0.1, fitScale), 1.5);
      const tx = rect.width / 2 - (minX + boundsW / 2) * targetScale;
      const ty = rect.height / 2 - (minY + boundsH / 2) * targetScale;
      setAnimating(true);
      setTransform({ x: tx, y: ty, scale: targetScale });
      if (animTimerRef.current) clearTimeout(animTimerRef.current);
      animTimerRef.current = setTimeout(() => setAnimating(false), 380);
    },
    [setTransform]
  );

  const handleRestoreTransform = useCallback(
    (_t: CanvasTransform) => {
      // Transform will be overridden by auto-fit on initial load
    },
    []
  );

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
    commitHistory,
    undo,
    redo,
    duplicateNode,
    pasteNodes,
  } = useNodes(canvasId, handleRestoreTransform);

  useEffect(() => {
    setTransformForSave(transform);
  }, [transform, setTransformForSave]);

  // Auto-fit all nodes into view on initial load
  useEffect(() => {
    if (loaded && !hasAutoFitted.current) {
      hasAutoFitted.current = true;
      if (nodes.length > 0) {
        fitAllNodes(nodes);
      }
    }
  }, [loaded, nodes, fitAllNodes]);

  useCanvasContext(rootFolder, nodes, canvasName);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const active = document.activeElement;
      const isEditable = active && (
        active.tagName === 'INPUT' ||
        active.tagName === 'TEXTAREA' ||
        (active as HTMLElement).isContentEditable
      );
      const isMod = e.metaKey || e.ctrlKey;

      // Cmd/Ctrl+K: toggle search palette
      if (isMod && e.key === 'k' && !isEditable) {
        e.preventDefault();
        setSearchOpen((prev) => !prev);
        return;
      }

      // Cmd/Ctrl+Z: undo
      if (isMod && !e.shiftKey && e.key === 'z' && !isEditable) {
        e.preventDefault();
        undo();
        return;
      }

      // Cmd/Ctrl+Shift+Z: redo
      if (isMod && e.shiftKey && e.key === 'z' && !isEditable) {
        e.preventDefault();
        redo();
        return;
      }

      // Cmd/Ctrl+A: select all nodes
      if (isMod && e.key === 'a' && !isEditable) {
        e.preventDefault();
        setSelectedNodeIds(nodes.map((n) => n.id));
        return;
      }

      // Cmd/Ctrl+D: duplicate selected node
      if (isMod && e.key === 'd' && !isEditable) {
        e.preventDefault();
        if (selectedNodeIds.length === 1) {
          const newNode = duplicateNode(selectedNodeIds[0]);
          if (newNode) setSelectedNodeIds([newNode.id]);
        }
        return;
      }

      // Cmd/Ctrl+C: copy selected nodes
      if (isMod && e.key === 'c' && !isEditable) {
        const selected = nodes.filter((n) => selectedNodeIds.includes(n.id));
        if (selected.length > 0) setClipboardNodes(selected);
        return;
      }

      // Cmd/Ctrl+V: paste nodes
      if (isMod && e.key === 'v' && !isEditable) {
        if (clipboardNodes.length > 0) {
          e.preventDefault();
          const created = pasteNodes(clipboardNodes);
          setSelectedNodeIds(created.map((n) => n.id));
        }
        return;
      }

      // Escape: close modals then clear selection
      if (e.key === 'Escape') {
        if (searchOpen) { setSearchOpen(false); return; }
        if (contextMenu) { setContextMenu(null); return; }
        setSelectedNodeIds([]);
        return;
      }

      // Delete / Backspace: delete selected nodes
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditable) {
        if (selectedNodeIds.length > 0) {
          e.preventDefault();
          removeNodes(selectedNodeIds);
          setSelectedNodeIds([]);
        }
        return;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [undo, redo, nodes, selectedNodeIds, duplicateNode, clipboardNodes, pasteNodes, removeNodes, searchOpen, contextMenu]);

  // Cmd/Ctrl+Tab to cycle through nodes (Shift reverses direction)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Tab') {
        const activeEl = document.activeElement;
        const isEditable = activeEl && (
          activeEl.tagName === 'INPUT' ||
          activeEl.tagName === 'TEXTAREA' ||
          (activeEl as HTMLElement).isContentEditable
        );
        if (!isEditable && nodes.length > 0) {
          e.preventDefault();
          const currentIndex = nodes.findIndex((n) => n.id === selectedNodeId);
          let nextIndex: number;
          if (e.shiftKey) {
            nextIndex = currentIndex <= 0 ? nodes.length - 1 : currentIndex - 1;
          } else {
            nextIndex = currentIndex >= nodes.length - 1 ? 0 : currentIndex + 1;
          }
          const nextNode = nodes[nextIndex];
          setSelectedNodeId(nextNode.id);
          setHighlightedId(nextNode.id);
          handleFocusNode(nextNode);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [nodes, selectedNodeId, handleFocusNode]);

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
    moveNode,
    moveNodes,
    transform.scale,
    nodes
  );
  const { resizingId, onResizeStart, onResizeMove, onResizeEnd } =
    useNodeResize(resizeNode, transform.scale);

  const containerRef = useRef<HTMLDivElement>(null);

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
    (type: "file" | "terminal" | "frame") => {
      if (!contextMenu) return;
      const node = addNode(type, contextMenu.canvasX, contextMenu.canvasY);
      setSelectedNodeIds([node.id]);
      setContextMenu(null);
    },
    [addNode, contextMenu]
  );

  const handleToolbarAddNode = useCallback(
    (type: "file" | "terminal" | "frame") => {
      if (!containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const centerX = rect.width / 2;
      const centerY = rect.height / 2;
      const pos = screenToCanvas(
        rect.left + centerX,
        rect.top + centerY,
        containerRef.current
      );
      const halfW = type === "file" ? 210 : type === "terminal" ? 240 : 300;
      const node = addNode(
        type,
        pos.x - halfW,
        pos.y - (type === "frame" ? 200 : 150)
      );
      setSelectedNodeIds([node.id]);
    },
    [addNode, screenToCanvas]
  );

  const handleCanvasClick = useCallback(
    (e: React.MouseEvent) => {
      if (contextMenu) setContextMenu(null);
      if ((e.target as HTMLElement).closest(".canvas-node")) return;
      setSelectedNodeIds([]);
    },
    [contextMenu]
  );

  const handleNodeSelect = useCallback((nodeId: string) => {
    setSelectedNodeIds([nodeId]);
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
    commitHistory();
  }, [canvasMouseUp, onDragEnd, onResizeEnd, commitHistory]);

  // Frames render first so they appear behind other nodes
  const sortedNodes = useMemo(
    () => [...nodes].sort((a, b) => {
      if (a.type === "frame" && b.type !== "frame") return -1;
      if (a.type !== "frame" && b.type === "frame") return 1;
      return 0;
    }),
    [nodes]
  );

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
          '--canvas-scale': transform.scale,
          transition: animating
            ? 'transform 0.32s cubic-bezier(0.25, 0.46, 0.45, 0.94), --canvas-scale 0.32s cubic-bezier(0.25, 0.46, 0.45, 0.94)'
            : undefined
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
