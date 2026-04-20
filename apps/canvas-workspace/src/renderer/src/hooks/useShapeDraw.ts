import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasNode, ShapeNodeData } from '../types';

type Point = { x: number; y: number };

export type ShapeKind = 'rect' | 'ellipse';

export type ShapeDraft = {
  kind: ShapeKind;
  start: Point;
  current: Point;
};

/** Minimum diagonal distance (canvas-px) before we commit a drag-drawn
 *  shape. A click that doesn't move past this threshold is treated as
 *  an accidental click and discarded. */
const DRAG_MIN_DISTANCE = 4;

/** Minimum shape dimension (canvas-px) when the user clicks or only
 *  drags a tiny distance and then lets go. */
const MIN_DIM = 40;

interface UseShapeDrawOptions {
  activeTool: string;
  screenToCanvas: (x: number, y: number, el: HTMLElement) => Point;
  getContainer: () => HTMLElement | null;
  addNode: (type: CanvasNode['type'], x: number, y: number) => CanvasNode;
  updateNode: (id: string, patch: Partial<CanvasNode>) => void;
  onCommitted: (node: CanvasNode) => void;
}

/**
 * Drag-to-draw primitive shapes. Activates whenever `activeTool` is
 * "shape-rect" or "shape-ellipse".
 *
 * Flow:
 *   mousedown on overlay  → start draft (no node yet)
 *   mousemove             → extend draft, render preview overlay
 *   mouseup               → commit a real shape node, revert to select tool
 *
 * The preview is purely local state; we do not create a node until the
 * user releases the mouse. This keeps undo/redo clean: one shape per
 * committed drag, not one-plus-many-resize entries.
 */
export const useShapeDraw = ({
  activeTool,
  screenToCanvas,
  getContainer,
  addNode,
  updateNode,
  onCommitted,
}: UseShapeDrawOptions) => {
  const [draft, setDraft] = useState<ShapeDraft | null>(null);
  const draftRef = useRef<ShapeDraft | null>(null);
  draftRef.current = draft;

  const kindFromTool = useCallback((): ShapeKind | null => {
    if (activeTool === 'shape-rect') return 'rect';
    if (activeTool === 'shape-ellipse') return 'ellipse';
    return null;
  }, [activeTool]);

  // Document-level listeners so a drag that leaves the overlay doesn't
  // get stuck — matches useEdgeInteraction's pattern.
  useEffect(() => {
    if (!draft) return;
    const handleMove = (e: MouseEvent) => {
      const el = getContainer();
      if (!el) return;
      const cur = screenToCanvas(e.clientX, e.clientY, el);
      setDraft((prev) => (prev ? { ...prev, current: cur } : prev));
    };
    const handleUp = () => {
      const d = draftRef.current;
      if (!d) {
        setDraft(null);
        return;
      }
      commitDraft(d);
      setDraft(null);
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
    // commitDraft is stable via the closed-over deps below
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, getContainer, screenToCanvas]);

  const commitDraft = useCallback(
    (d: ShapeDraft) => {
      const dx = d.current.x - d.start.x;
      const dy = d.current.y - d.start.y;
      const dist = Math.hypot(dx, dy);

      // Compute the bounding box. Swapping sign handles drags in any
      // direction (top-left → bottom-right, bottom-right → top-left, etc).
      let x = Math.min(d.start.x, d.current.x);
      let y = Math.min(d.start.y, d.current.y);
      let width = Math.abs(dx);
      let height = Math.abs(dy);

      if (dist < DRAG_MIN_DISTANCE) {
        // Treat as a click — drop a default-sized shape centered on the
        // click point so the user still gets something.
        width = MIN_DIM * 2;
        height = MIN_DIM * 1.4;
        x = d.start.x - width / 2;
        y = d.start.y - height / 2;
      } else {
        // Guard against degenerate thin strips — enforce a minimum along
        // each axis so users don't end up with a 200×1 sliver.
        if (width < MIN_DIM) {
          x -= (MIN_DIM - width) / 2;
          width = MIN_DIM;
        }
        if (height < MIN_DIM) {
          y -= (MIN_DIM - height) / 2;
          height = MIN_DIM;
        }
      }

      const node = addNode('shape', x, y);
      const nextData: ShapeNodeData = {
        kind: d.kind,
        fill: '#E8EEF7',
        stroke: '#5B7CBF',
        strokeWidth: 2,
      };
      updateNode(node.id, { width, height, data: nextData });
      onCommitted({ ...node, x, y, width, height, data: nextData });
    },
    [addNode, updateNode, onCommitted],
  );

  const handleOverlayMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      const kind = kindFromTool();
      if (!kind) return;
      const el = getContainer();
      if (!el) return;
      e.preventDefault();
      e.stopPropagation();
      const start = screenToCanvas(e.clientX, e.clientY, el);
      setDraft({ kind, start, current: start });
    },
    [getContainer, kindFromTool, screenToCanvas],
  );

  return {
    draft,
    handleOverlayMouseDown,
    isActive: kindFromTool() !== null,
  };
};
