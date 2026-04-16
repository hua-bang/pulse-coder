import { useCallback, useRef, useState } from 'react';
import type { CanvasNode } from '../types';

/** Minimum screen-pixel distance the cursor must travel after mousedown before
 *  we promote the gesture to a marquee. Below this threshold a drag collapses
 *  back to a plain click so the existing canvas-click deselect path still
 *  fires. Matches the "small accidental drag" tolerance used by tldraw. */
const DRAG_THRESHOLD_PX = 3;

/** Rectangle in canvas (transformed) coordinate space. `width`/`height` are
 *  always non-negative; the start point may be any corner of the drag. */
export interface MarqueeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface UseMarqueeSelectOptions {
  nodes: CanvasNode[];
  screenToCanvas: (sx: number, sy: number, container: HTMLElement) => { x: number; y: number };
  getContainer: () => HTMLElement | null;
  setSelectedNodeIds: (ids: string[]) => void;
  /** Clear any selected edge when the marquee commits — keeps node and edge
   *  selection mutually exclusive, matching the existing click semantics. */
  setSelectedEdgeId: (id: string | null) => void;
}

const rectsIntersect = (
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean =>
  ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;

const rectContains = (
  outer: MarqueeRect,
  bx: number, by: number, bw: number, bh: number,
): boolean =>
  bx >= outer.x &&
  by >= outer.y &&
  bx + bw <= outer.x + outer.width &&
  by + bh <= outer.y + outer.height;

/**
 * Compute which nodes fall inside the marquee rectangle.
 *
 * Frame nodes use **full containment** — a frame only joins the selection
 * when the marquee fully encloses its bounding box. Without this, any small
 * drag inside a big frame would select the frame along with the nodes the
 * user actually wanted, which is confusing (and dragging the frame then
 * cascades to every child, quietly moving things the user didn't pick).
 *
 * Non-frame nodes use **bbox intersection** — any overlap with the marquee
 * counts, matching the flow designers expect from Figma/tldraw.
 */
const computeHits = (rect: MarqueeRect, nodes: CanvasNode[]): string[] => {
  const hits: string[] = [];
  for (const n of nodes) {
    if (n.type === 'frame') {
      if (rectContains(rect, n.x, n.y, n.width, n.height)) hits.push(n.id);
    } else {
      if (rectsIntersect(rect.x, rect.y, rect.width, rect.height, n.x, n.y, n.width, n.height)) {
        hits.push(n.id);
      }
    }
  }
  return hits;
};

/**
 * Marquee (drag-select) gesture for the canvas.
 *
 * Lifecycle:
 *  1. `begin(e, currentSelection)` on a blank-canvas mousedown — records the
 *     start point and the base selection (used for shift+drag additive mode).
 *     Does **not** show the rectangle yet.
 *  2. `move(e)` on mousemove — once the cursor passes `DRAG_THRESHOLD_PX` the
 *     rectangle becomes visible and the selection is updated live.
 *  3. `end()` on mouseup — clears the rectangle and returns `true` if a
 *     marquee was actually drawn, so the caller can suppress the trailing
 *     `onClick` that would otherwise wipe the fresh selection.
 *
 * The hook keeps the gesture state in refs and only the rendered rectangle
 * in React state, so mousemove doesn't rerender the Canvas for pending
 * (sub-threshold) gestures.
 */
export const useMarqueeSelect = ({
  nodes,
  screenToCanvas,
  getContainer,
  setSelectedNodeIds,
  setSelectedEdgeId,
}: UseMarqueeSelectOptions) => {
  const [rect, setRect] = useState<MarqueeRect | null>(null);

  /** Pending gesture — set on mousedown, cleared on mouseup/cancel. A non-null
   *  value does NOT imply the marquee is visible yet (see `active`). */
  const pending = useRef<{
    startX: number;
    startY: number;
    screenStartX: number;
    screenStartY: number;
    additive: boolean;
    baseSelection: string[];
  } | null>(null);

  /** True once the drag passed the threshold and we committed to a marquee.
   *  Used by `end()` to tell the Canvas "this was a real marquee — don't fire
   *  the deselect-on-click fallback". */
  const active = useRef(false);

  const begin = useCallback(
    (e: React.MouseEvent, currentSelection: string[]) => {
      const container = getContainer();
      if (!container) return;
      const p = screenToCanvas(e.clientX, e.clientY, container);
      pending.current = {
        startX: p.x,
        startY: p.y,
        screenStartX: e.clientX,
        screenStartY: e.clientY,
        additive: e.shiftKey,
        baseSelection: e.shiftKey ? [...currentSelection] : [],
      };
      active.current = false;
    },
    [getContainer, screenToCanvas],
  );

  const move = useCallback(
    (e: React.MouseEvent) => {
      const p = pending.current;
      if (!p) return;
      const container = getContainer();
      if (!container) return;

      if (!active.current) {
        const dx = Math.abs(e.clientX - p.screenStartX);
        const dy = Math.abs(e.clientY - p.screenStartY);
        if (dx < DRAG_THRESHOLD_PX && dy < DRAG_THRESHOLD_PX) return;
        active.current = true;
      }

      const cur = screenToCanvas(e.clientX, e.clientY, container);
      const newRect: MarqueeRect = {
        x: Math.min(p.startX, cur.x),
        y: Math.min(p.startY, cur.y),
        width: Math.abs(cur.x - p.startX),
        height: Math.abs(cur.y - p.startY),
      };
      setRect(newRect);

      const hits = computeHits(newRect, nodes);
      if (p.additive) {
        const merged = new Set(p.baseSelection);
        for (const id of hits) merged.add(id);
        setSelectedNodeIds(Array.from(merged));
      } else {
        setSelectedNodeIds(hits);
      }
      setSelectedEdgeId(null);
    },
    [getContainer, nodes, screenToCanvas, setSelectedEdgeId, setSelectedNodeIds],
  );

  /** Terminate the gesture. Returns `true` iff a marquee was actually drawn
   *  (i.e. the drag passed the threshold), so the caller can suppress the
   *  trailing onClick. */
  const end = useCallback((): boolean => {
    const wasActive = active.current;
    pending.current = null;
    active.current = false;
    if (wasActive) setRect(null);
    return wasActive;
  }, []);

  const cancel = useCallback(() => {
    pending.current = null;
    active.current = false;
    setRect(null);
  }, []);

  return { rect, begin, move, end, cancel };
};
