import { useCallback, useRef, useState } from "react";
import type { CanvasNode } from "../types";
import { collectFrameDescendants } from "../utils/frameHierarchy";

export const useNodeDrag = (
  moveNode: (id: string, x: number, y: number) => void,
  moveNodes: (moves: Array<{ id: string; x: number; y: number }>) => void,
  scale: number,
  nodes: CanvasNode[]
) => {
  const dragging = useRef<{
    id: string;
    startX: number;
    startY: number;
    nodeX: number;
    nodeY: number;
    children: Array<{ id: string; nodeX: number; nodeY: number }>;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  // Every node that moves with the drag (the primary node plus, for frames,
  // every descendant frame / node). Used so the whole group can share the
  // lifted `.canvas-node--dragging` stacking context — otherwise a dragged
  // parent frame's opaque body would paint over its nested children.
  const [draggingIds, setDraggingIds] = useState<Set<string>>(() => new Set());

  const onDragStart = useCallback(
    (e: React.MouseEvent, node: CanvasNode) => {
      if (e.button !== 0 || e.altKey) return;
      e.stopPropagation();

      // If dragging a frame, also drag every transitive descendant — both
      // regular nodes and nested child frames.
      let children: Array<{ id: string; nodeX: number; nodeY: number }> = [];
      if (node.type === "frame") {
        children = collectFrameDescendants(node.id, nodes).map((n) => ({
          id: n.id,
          nodeX: n.x,
          nodeY: n.y,
        }));
      }

      dragging.current = {
        id: node.id,
        startX: e.clientX,
        startY: e.clientY,
        nodeX: node.x,
        nodeY: node.y,
        children
      };
      setDraggingId(node.id);
      setDraggingIds(new Set([node.id, ...children.map((c) => c.id)]));
    },
    [nodes]
  );

  const onDragMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging.current) return;
      const d = dragging.current;
      const dx = (e.clientX - d.startX) / scale;
      const dy = (e.clientY - d.startY) / scale;

      if (d.children.length > 0) {
        // Batch move frame + children
        const moves = [
          { id: d.id, x: d.nodeX + dx, y: d.nodeY + dy },
          ...d.children.map((c) => ({
            id: c.id,
            x: c.nodeX + dx,
            y: c.nodeY + dy
          }))
        ];
        moveNodes(moves);
      } else {
        moveNode(d.id, d.nodeX + dx, d.nodeY + dy);
      }
    },
    [moveNode, moveNodes, scale]
  );

  const onDragEnd = useCallback(() => {
    dragging.current = null;
    setDraggingId(null);
    setDraggingIds(new Set());
  }, []);

  return { draggingId, draggingIds, onDragStart, onDragMove, onDragEnd };
};
