import { useCallback, useRef, useState } from "react";
import type { CanvasTransform } from "../types";

const MIN_SCALE = 0.1;
const MAX_SCALE = 4;
const ZOOM_SENSITIVITY = 0.005;

const clampScale = (s: number) =>
  Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));

const safeNum = (n: number, fallback = 0) =>
  Number.isFinite(n) ? n : fallback;

export const useCanvas = (isHandTool = false) => {
  const [transform, setTransform] = useState<CanvasTransform>({
    x: 0,
    y: 0,
    scale: 1
  });

  const isPanning = useRef(false);
  const lastMouse = useRef({ x: 0, y: 0 });

  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      e.stopPropagation();
      const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const clampedDelta = Math.max(-50, Math.min(50, e.deltaY));
      setTransform((prev) => {
        const factor = 1 - clampedDelta * ZOOM_SENSITIVITY;
        const newScale = clampScale(prev.scale * factor);
        const ratio = newScale / prev.scale;
        return {
          x: safeNum(mx - (mx - prev.x) * ratio),
          y: safeNum(my - (my - prev.y) * ratio),
          scale: newScale
        };
      });
    } else {
      const dx = e.deltaX;
      const dy = e.deltaY;
      setTransform((prev) => ({
        ...prev,
        x: safeNum(prev.x - dx),
        y: safeNum(prev.y - dy)
      }));
    }
  }, []);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (
        e.button === 1 ||
        (e.button === 0 && e.altKey) ||
        (e.button === 0 && isHandTool)
      ) {
        isPanning.current = true;
        lastMouse.current = { x: e.clientX, y: e.clientY };
        e.preventDefault();
      }
    },
    [isHandTool]
  );

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    if (!isPanning.current) return;
    const dx = e.clientX - lastMouse.current.x;
    const dy = e.clientY - lastMouse.current.y;
    lastMouse.current = { x: e.clientX, y: e.clientY };
    setTransform((prev) => ({
      ...prev,
      x: safeNum(prev.x + dx),
      y: safeNum(prev.y + dy)
    }));
  }, []);

  const handleMouseUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const screenToCanvas = useCallback(
    (screenX: number, screenY: number, container: HTMLElement) => {
      const rect = container.getBoundingClientRect();
      return {
        x: (screenX - rect.left - transform.x) / transform.scale,
        y: (screenY - rect.top - transform.y) / transform.scale
      };
    },
    [transform]
  );

  const resetTransform = useCallback(() => {
    setTransform({ x: 0, y: 0, scale: 1 });
  }, []);

  return {
    transform,
    setTransform,
    handleWheel,
    handleMouseDown,
    handleMouseMove,
    handleMouseUp,
    screenToCanvas,
    resetTransform
  };
};
