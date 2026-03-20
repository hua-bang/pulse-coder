import { useCallback, useRef, useState } from "react";
import type { CanvasNode } from "../types";

export const useNodeDrag = (
  moveNode: (id: string, x: number, y: number) => void,
  scale: number
) => {
  const dragging = useRef<{
    id: string;
    startX: number;
    startY: number;
    nodeX: number;
    nodeY: number;
  } | null>(null);
  const [draggingId, setDraggingId] = useState<string | null>(null);

  const onDragStart = useCallback(
    (e: React.MouseEvent, node: CanvasNode) => {
      if (e.button !== 0 || e.altKey) return;
      e.stopPropagation();
      dragging.current = {
        id: node.id,
        startX: e.clientX,
        startY: e.clientY,
        nodeX: node.x,
        nodeY: node.y
      };
      setDraggingId(node.id);
    },
    []
  );

  const onDragMove = useCallback(
    (e: React.MouseEvent) => {
      if (!dragging.current) return;
      const dx = (e.clientX - dragging.current.startX) / scale;
      const dy = (e.clientY - dragging.current.startY) / scale;
      moveNode(
        dragging.current.id,
        dragging.current.nodeX + dx,
        dragging.current.nodeY + dy
      );
    },
    [moveNode, scale]
  );

  const onDragEnd = useCallback(() => {
    dragging.current = null;
    setDraggingId(null);
  }, []);

  return { draggingId, onDragStart, onDragMove, onDragEnd };
};
