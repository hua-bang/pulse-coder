import { useCallback, useRef, useState } from "react";

const MIN_WIDTH = 200;
const MIN_HEIGHT = 120;

export const useNodeResize = (
  resizeNode: (id: string, width: number, height: number) => void,
  scale: number
) => {
  const resizing = useRef<{
    id: string;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
    edge: ResizeEdge;
  } | null>(null);
  const [resizingId, setResizingId] = useState<string | null>(null);

  const onResizeStart = useCallback(
    (
      e: React.MouseEvent,
      nodeId: string,
      width: number,
      height: number,
      edge: ResizeEdge
    ) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      resizing.current = {
        id: nodeId,
        startX: e.clientX,
        startY: e.clientY,
        startW: width,
        startH: height,
        edge
      };
      setResizingId(nodeId);
    },
    []
  );

  const onResizeMove = useCallback(
    (e: React.MouseEvent) => {
      if (!resizing.current) return;
      const r = resizing.current;
      const dx = (e.clientX - r.startX) / scale;
      const dy = (e.clientY - r.startY) / scale;

      let newW = r.startW;
      let newH = r.startH;

      if (r.edge === "right" || r.edge === "bottom-right") {
        newW = Math.max(MIN_WIDTH, r.startW + dx);
      }
      if (r.edge === "bottom" || r.edge === "bottom-right") {
        newH = Math.max(MIN_HEIGHT, r.startH + dy);
      }

      resizeNode(r.id, Math.round(newW), Math.round(newH));
    },
    [resizeNode, scale]
  );

  const onResizeEnd = useCallback(() => {
    resizing.current = null;
    setResizingId(null);
  }, []);

  return { resizingId, onResizeStart, onResizeMove, onResizeEnd };
};

export type ResizeEdge = "right" | "bottom" | "bottom-right";
