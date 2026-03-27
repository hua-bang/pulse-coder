import { useCallback, useRef, useState } from 'react';
import type { CanvasNode, CanvasTransform } from '../types';

export const useCanvasFit = (
  containerRef: React.RefObject<HTMLDivElement | null>,
  setTransform: (t: CanvasTransform) => void,
) => {
  const [animating, setAnimating] = useState(false);
  const animTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const triggerAnimation = useCallback(() => {
    setAnimating(true);
    if (animTimerRef.current) clearTimeout(animTimerRef.current);
    animTimerRef.current = setTimeout(() => setAnimating(false), 380);
  }, []);

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
      setTransform({ x: tx, y: ty, scale: targetScale });
      triggerAnimation();
    },
    [containerRef, setTransform, triggerAnimation]
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
      setTransform({ x: tx, y: ty, scale: targetScale });
      triggerAnimation();
    },
    [containerRef, setTransform, triggerAnimation]
  );

  return { animating, handleFocusNode, fitAllNodes };
};
