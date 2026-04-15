import { useCallback, useEffect, useRef, useState } from 'react';
import type { CanvasEdge, CanvasNode, EdgeEndpoint } from '../types';
import {
  bendFromCursor,
  createDefaultEdge,
  findNodeAtCanvasPoint,
  resolveEndpointToward,
} from '../utils/edgeFactory';

/** Minimum pixel distance between connect-drag start and end before we
 *  commit a new edge. Clicks that don't move past this threshold are
 *  treated as an accidental click in connect mode and discarded. */
const CONNECT_DRAG_MIN_DISTANCE = 6;

export type Point = { x: number; y: number };

/**
 * Active edge interaction. Only one can be in-flight at a time; the
 * overlay layer reads this to render the preview line and the handle
 * positions while the drag is live.
 */
export type EdgeInteractionState =
  | {
      kind: 'connect';
      source: EdgeEndpoint;
      /** Where the mouse currently is in canvas coords. */
      cursor: Point;
      /** Node under the cursor, if any — for preview highlighting. */
      hoverNodeId: string | null;
      /** Total canvas-px distance moved since start. Used to decide
       *  whether to commit vs. discard on mouseup. */
      distance: number;
    }
  | {
      kind: 'move-end';
      edgeId: string;
      /** Which end of the edge is being dragged. */
      end: 'source' | 'target';
      /** The OTHER endpoint — kept frozen for the duration of the drag
       *  so preview math stays stable even if its node gets moved by
       *  some other hook. */
      frozen: EdgeEndpoint;
      cursor: Point;
      hoverNodeId: string | null;
    }
  | {
      kind: 'move-bend';
      edgeId: string;
      /** s/t are the resolved screen-space coords of the edge's two
       *  endpoints as-of-drag-start. We freeze them so that the bend
       *  math (perpendicular projection of cursor onto s→t) doesn't
       *  drift if the endpoints' resolved positions would otherwise
       *  shift mid-drag. */
      s: Point;
      t: Point;
      cursor: Point;
      /** Edge.bend at drag start. We apply cursor-offset deltas on top
       *  of this so a drag that starts *on the curve* (not on the
       *  midpoint handle) doesn't yank the bend to the cursor's raw
       *  perpendicular offset. */
      originBend: number;
      /** Cursor's perpendicular offset from the straight line s→t at
       *  drag start. Subtracted from subsequent offsets to yield a
       *  pure delta. */
      originOffset: number;
    };

interface UseEdgeInteractionArgs {
  /** All nodes, used for hit-testing and for resolving node-bound
   *  endpoints' screen positions. */
  nodes: CanvasNode[];
  /** Same `sortedNodes` list the canvas renders — hit-test walks this
   *  in reverse so the visually-topmost node wins. */
  sortedNodes: CanvasNode[];
  /** Screen → canvas coordinate conversion (from useCanvas). */
  screenToCanvas: (screenX: number, screenY: number, container: HTMLElement) => Point;
  /** The canvas-container DOM element, needed by screenToCanvas. */
  getContainer: () => HTMLElement | null;
  addEdge: (edge: CanvasEdge) => CanvasEdge;
  updateEdge: (id: string, patch: Partial<CanvasEdge>, addToHistory?: boolean) => void;
  commitHistory: () => void;
  /** Edges are needed by move-end / move-bend to look up the edge
   *  being dragged. */
  edges: CanvasEdge[];
  /** Called once after a connect-drag successfully commits a new edge
   *  (ignored for discarded clicks and self-drops). The Canvas wires
   *  this to `setActiveTool('select')` so the user isn't stuck in
   *  connect mode after drawing one arrow. */
  onConnectCommitted?: (edgeId: string) => void;
}

/**
 * Resolves the current cursor position into an EdgeEndpoint:
 *  - if it's over a node → node-bound (auto anchor, which will
 *    render as the bbox boundary point toward the other endpoint),
 *  - else a free point.
 */
const cursorToEndpoint = (
  cursor: Point,
  sortedNodes: CanvasNode[],
): { endpoint: EdgeEndpoint; hoverNodeId: string | null } => {
  const hit = findNodeAtCanvasPoint(sortedNodes, cursor.x, cursor.y);
  if (hit) {
    return {
      endpoint: { kind: 'node', nodeId: hit.id, anchor: 'auto' },
      hoverNodeId: hit.id,
    };
  }
  return {
    endpoint: { kind: 'point', x: cursor.x, y: cursor.y },
    hoverNodeId: null,
  };
};

/**
 * Coordinates the three live edge interactions — drawing a new edge in
 * connect mode, dragging an existing edge's start/end handle, and
 * dragging a bend handle. Encapsulating the global mousemove/mouseup
 * listeners here keeps the Canvas component from accumulating another
 * half-dozen event handlers.
 */
export const useEdgeInteraction = ({
  nodes,
  sortedNodes,
  screenToCanvas,
  getContainer,
  addEdge,
  updateEdge,
  commitHistory,
  edges,
  onConnectCommitted,
}: UseEdgeInteractionArgs) => {
  const [state, setState] = useState<EdgeInteractionState | null>(null);
  // Mirror of state for use inside the stable window-level listeners,
  // which are installed once per interaction start.
  const stateRef = useRef<EdgeInteractionState | null>(null);
  stateRef.current = state;

  // Fresh view of nodes for the listeners to hit-test against.
  const sortedNodesRef = useRef(sortedNodes);
  sortedNodesRef.current = sortedNodes;

  const screenToCanvasRef = useRef(screenToCanvas);
  screenToCanvasRef.current = screenToCanvas;

  const nodesById = useRef(new Map<string, CanvasNode>());
  nodesById.current = new Map(nodes.map((n) => [n.id, n]));

  /**
   * Compute the mouse position in canvas coordinates. Returns null if
   * the container isn't mounted (shouldn't happen during an active
   * drag, but we defensively bail).
   */
  const toCanvas = useCallback((clientX: number, clientY: number): Point | null => {
    const container = getContainer();
    if (!container) return null;
    return screenToCanvasRef.current(clientX, clientY, container);
  }, [getContainer]);

  const handleMove = useCallback((clientX: number, clientY: number) => {
    const current = stateRef.current;
    if (!current) return;
    const pt = toCanvas(clientX, clientY);
    if (!pt) return;

    if (current.kind === 'connect') {
      const hit = findNodeAtCanvasPoint(sortedNodesRef.current, pt.x, pt.y);
      const dx = pt.x - current.cursor.x;
      const dy = pt.y - current.cursor.y;
      setState({
        ...current,
        cursor: pt,
        hoverNodeId: hit?.id ?? null,
        distance: current.distance + Math.hypot(dx, dy),
      });
      return;
    }

    if (current.kind === 'move-end') {
      const hit = findNodeAtCanvasPoint(sortedNodesRef.current, pt.x, pt.y);
      setState({
        ...current,
        cursor: pt,
        hoverNodeId: hit?.id ?? null,
      });
      // Live preview: also push the new endpoint to the store without
      // adding to history. We commit one history step on mouseup.
      const newEndpoint: EdgeEndpoint = hit
        ? { kind: 'node', nodeId: hit.id, anchor: 'auto' }
        : { kind: 'point', x: pt.x, y: pt.y };
      updateEdge(
        current.edgeId,
        current.end === 'source' ? { source: newEndpoint } : { target: newEndpoint },
        false,
      );
      return;
    }

    if (current.kind === 'move-bend') {
      const offset = bendFromCursor(current.s, current.t, pt);
      const newBend = current.originBend + (offset - current.originOffset);
      setState({ ...current, cursor: pt });
      updateEdge(current.edgeId, { bend: newBend }, false);
      return;
    }
  }, [toCanvas, updateEdge]);

  const handleUp = useCallback(() => {
    const current = stateRef.current;
    if (!current) return;

    if (current.kind === 'connect') {
      if (current.distance >= CONNECT_DRAG_MIN_DISTANCE) {
        const { endpoint: target } = cursorToEndpoint(current.cursor, sortedNodesRef.current);
        // If the user dropped back on the same node they started
        // from, skip — a self-loop is almost always an accident.
        // Drops on blank space OR a different node both commit.
        const isSelfDrop =
          current.source.kind === 'node' &&
          target.kind === 'node' &&
          current.source.nodeId === target.nodeId;
        if (!isSelfDrop) {
          const edge = addEdge(createDefaultEdge(current.source, target));
          // Hand control back to the caller so it can exit connect mode
          // (tldraw-style: you draw one arrow, then you're back in select).
          onConnectCommitted?.(edge.id);
        }
      }
    } else if (current.kind === 'move-end' || current.kind === 'move-bend') {
      // Live updates during move-* were history-silent; commit a
      // single undo step here so the whole drag is atomic.
      commitHistory();
    }

    setState(null);
  }, [addEdge, commitHistory, onConnectCommitted]);

  // Window-level listeners are installed only while an interaction is
  // live. Using window (not the canvas container) means the drag keeps
  // tracking when the cursor slips off the canvas — matches the
  // existing node-drag behaviour.
  useEffect(() => {
    if (!state) return;
    const onMove = (e: MouseEvent) => handleMove(e.clientX, e.clientY);
    const onUp = () => handleUp();
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [state, handleMove, handleUp]);

  /**
   * Begin drawing a new edge. Called by the connect-mode overlay.
   * `clientX/Y` are the screen coords of the mousedown event.
   */
  const beginConnect = useCallback((clientX: number, clientY: number) => {
    const pt = toCanvas(clientX, clientY);
    if (!pt) return;
    const { endpoint: source, hoverNodeId } = cursorToEndpoint(pt, sortedNodesRef.current);
    setState({
      kind: 'connect',
      source,
      cursor: pt,
      hoverNodeId,
      distance: 0,
    });
  }, [toCanvas]);

  /**
   * Begin dragging an endpoint of an existing edge. `end === 'source'`
   * moves the start handle, `'target'` moves the end handle.
   */
  const beginMoveEnd = useCallback((
    edgeId: string,
    end: 'source' | 'target',
    clientX: number,
    clientY: number,
  ) => {
    const pt = toCanvas(clientX, clientY);
    if (!pt) return;
    const edge = edges.find((e) => e.id === edgeId);
    if (!edge) return;
    const frozen = end === 'source' ? edge.target : edge.source;
    const hit = findNodeAtCanvasPoint(sortedNodesRef.current, pt.x, pt.y);
    setState({
      kind: 'move-end',
      edgeId,
      end,
      frozen,
      cursor: pt,
      hoverNodeId: hit?.id ?? null,
    });
  }, [edges, toCanvas]);

  /**
   * Begin dragging the bend handle. We snapshot the resolved endpoint
   * positions so the perpendicular projection stays anchored even if
   * the endpoints move slightly mid-drag (e.g. parent frame is being
   * reflowed by something else).
   */
  const beginMoveBend = useCallback((
    edgeId: string,
    s: Point,
    t: Point,
    clientX: number,
    clientY: number,
  ) => {
    const pt = toCanvas(clientX, clientY);
    if (!pt) return;
    const edge = edges.find((e) => e.id === edgeId);
    const originBend = edge?.bend ?? 0;
    // Cursor's offset-from-straight-line at mousedown time — baseline
    // for delta math in handleMove so dragging from anywhere on the
    // curve (not just the midpoint handle) feels continuous.
    const originOffset = bendFromCursor(s, t, pt);
    setState({
      kind: 'move-bend',
      edgeId,
      s,
      t,
      cursor: pt,
      originBend,
      originOffset,
    });
  }, [edges, toCanvas]);

  /**
   * Resolve the current preview edge's endpoints (for rendering the
   * dashed draft line). Returns null when no connect/move-end drag is
   * active. Handles both free-point endpoints and node-bound auto
   * anchors (computed toward the opposite endpoint).
   */
  const getPreviewEndpoints = useCallback((): { s: Point; t: Point } | null => {
    if (!state) return null;
    if (state.kind === 'connect') {
      const targetPoint: Point = { x: state.cursor.x, y: state.cursor.y };
      const s = resolveEndpointToward(state.source, nodesById.current, targetPoint);
      return { s, t: targetPoint };
    }
    if (state.kind === 'move-end') {
      const frozenPoint = resolveEndpointToward(state.frozen, nodesById.current, state.cursor);
      if (state.end === 'source') {
        return { s: state.cursor, t: frozenPoint };
      }
      return { s: frozenPoint, t: state.cursor };
    }
    return null;
  }, [state]);

  return {
    state,
    beginConnect,
    beginMoveEnd,
    beginMoveBend,
    getPreviewEndpoints,
  };
};
