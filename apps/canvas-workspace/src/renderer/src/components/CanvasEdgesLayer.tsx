import { useMemo } from 'react';
import type {
  CanvasEdge,
  CanvasNode,
  EdgeArrowCap,
  EdgeStroke,
} from '../types';
import {
  bendHandlePoint,
  resolveEndpoint,
  resolveEndpointToward,
} from '../utils/edgeFactory';
import type { EdgeInteractionState, Point } from '../hooks/useEdgeInteraction';

interface Props {
  edges: CanvasEdge[];
  nodes: CanvasNode[];
  selectedEdgeId: string | null;
  onSelectEdge?: (id: string | null) => void;
  /** Live interaction state — renders preview / freezes the edge under
   *  drag. Optional because Step 1 call sites don't pass it. */
  interactionState?: EdgeInteractionState | null;
  /** Preview endpoints resolved by the interaction hook. When set, we
   *  draw a dashed draft line between these two points. */
  previewEndpoints?: { s: Point; t: Point } | null;
  onHandleMouseDown?: (
    edgeId: string,
    handle: 'source' | 'target' | 'bend',
    e: React.MouseEvent,
    ctx: { s: Point; t: Point },
  ) => void;
  /** Mousedown on the edge body (not a handle). Used to start a "move
   *  the whole edge" drag — the hit-proxy forwards here and the
   *  interaction hook translates free-point endpoints by the cursor
   *  delta while leaving node-bound endpoints anchored. */
  onBodyMouseDown?: (edgeId: string, e: React.MouseEvent) => void;
  /** Double-click on the edge body. Used to enter edge-label edit mode.
   *  The hit-proxy swallows the event so it doesn't bubble up to the
   *  canvas-container's blank dbl-click handler (which spawns the
   *  new-node context menu). */
  onBodyDoubleClick?: (edgeId: string, e: React.MouseEvent) => void;
}

const DEFAULT_STROKE: Required<EdgeStroke> = {
  color: '#1f2328',
  width: 2.4,
  style: 'solid',
};

const SELECTION_COLOR = '#2a7fff';
const HIT_PROXY_WIDTH = 10;
const HANDLE_RADIUS = 5;
/** Canvas-space gap between an arrow's tip and the node boundary it points
 *  at. Without this, the arrow-head marker sits flush against the node
 *  and gets visually swallowed by the node's background/border. tldraw
 *  leaves similar breathing room for the same reason. */
const ARROW_NODE_GAP = 6;

const strokeDasharray = (style: EdgeStroke['style']): string | undefined => {
  switch (style) {
    case 'dashed': return '6 4';
    case 'dotted': return '1.5 3';
    case 'solid':
    default:       return undefined;
  }
};

const bendControlPoint = (
  sx: number, sy: number,
  tx: number, ty: number,
  bend: number,
): { cx: number; cy: number } => {
  const mx = (sx + tx) / 2;
  const my = (sy + ty) / 2;
  if (!bend) return { cx: mx, cy: my };
  const dx = tx - sx;
  const dy = ty - sy;
  const len = Math.hypot(dx, dy) || 1;
  const nx = dy / len;
  const ny = -dx / len;
  // bend = peak offset of rendered curve; control point sits at 2×bend
  // because a quadratic's t=0.5 value is (M + P1)/2 (see useEdgeInteraction).
  return { cx: mx + nx * bend * 2, cy: my + ny * bend * 2 };
};

const buildPathData = (s: Point, t: Point, bend: number): string => {
  if (!bend) return `M ${s.x} ${s.y} L ${t.x} ${t.y}`;
  const { cx, cy } = bendControlPoint(s.x, s.y, t.x, t.y, bend);
  return `M ${s.x} ${s.y} Q ${cx} ${cy} ${t.x} ${t.y}`;
};

/**
 * Pull the resolved `end` point back from the node boundary by `gap`
 * canvas units along the straight line from `other` → `end`. Used when
 * the endpoint is node-bound AND has a visible arrow cap, so the cap
 * doesn't render flush against the node (where it visually merges into
 * the node's border/background).
 *
 * Returns `end` unchanged when `gap` is 0 or the two points coincide.
 */
const insetTowardOther = (end: Point, other: Point, gap: number): Point => {
  if (gap <= 0) return end;
  const dx = end.x - other.x;
  const dy = end.y - other.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return end;
  return {
    x: end.x - (dx / len) * gap,
    y: end.y - (dy / len) * gap,
  };
};

const capId = (prefix: string, cap: EdgeArrowCap, color: string): string => {
  const hex = color.replace(/[^a-zA-Z0-9]/g, '_');
  return `${prefix}-${cap}-${hex}`;
};

const useMarkerDefs = (edges: CanvasEdge[]) => {
  return useMemo(() => {
    const markers = new Map<
      string,
      { id: string; cap: EdgeArrowCap; color: string; side: 'head' | 'tail' }
    >();
    for (const edge of edges) {
      const color = edge.stroke?.color ?? DEFAULT_STROKE.color;
      const head = edge.arrowHead ?? 'triangle';
      const tail = edge.arrowTail ?? 'none';
      if (head !== 'none') {
        const id = capId('edge-head', head, color);
        if (!markers.has(id)) markers.set(id, { id, cap: head, color, side: 'head' });
      }
      if (tail !== 'none') {
        const id = capId('edge-tail', tail, color);
        if (!markers.has(id)) markers.set(id, { id, cap: tail, color, side: 'tail' });
      }
    }
    return Array.from(markers.values());
  }, [edges]);
};

const MarkerShape = ({ cap, color }: { cap: EdgeArrowCap; color: string }) => {
  switch (cap) {
    case 'triangle':
      // A touch slimmer than a square triangle (base 7 vs length 10)
      // reads as more "arrow-like" than the old 10×10 triangle, which
      // looked stubby next to longer edges.
      return <path d="M0,1.5 L10,5 L0,8.5 z" fill={color} />;
    case 'arrow':
      // Open chevron. strokeWidth is expressed in the marker's viewBox
      // coord system, which — thanks to markerUnits="strokeWidth" — is
      // proportional to the line's stroke-width. A value of 1.8 ends up
      // ≈0.9× the line's own stroke, matching classic open-arrow weight.
      return (
        <path
          d="M0,1.5 L10,5 L0,8.5"
          fill="none"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );
    case 'dot':
      return <circle cx={5} cy={5} r={3.2} fill={color} />;
    case 'bar':
      return <rect x={4} y={0} width={2} height={10} fill={color} />;
    case 'none':
    default:
      return null;
  }
};

const Markers = ({
  markers,
}: {
  markers: Array<{ id: string; cap: EdgeArrowCap; color: string; side: 'head' | 'tail' }>;
}) => (
  <defs>
    {markers.map(({ id, cap, color, side }) => (
      <marker
        key={id}
        id={id}
        // markerUnits="strokeWidth" makes the marker (and its inner
        // geometry) scale with the line's stroke-width so the arrow
        // stays proportional to whichever width the user picks. 4×4
        // keeps the rendered cap slim — length ≈ 4× stroke, which
        // matches how tldraw/Figma size their arrow heads.
        markerWidth={4}
        markerHeight={4}
        viewBox="0 0 10 10"
        orient={side === 'head' ? 'auto' : 'auto-start-reverse'}
        // 'triangle' and 'arrow' have their point at (10, 5) in the
        // viewBox — the refPoint must sit *on* the point so that point
        // lands exactly at the path endpoint. 'dot' and 'bar' are
        // symmetric, so centering (refX=5) places them *over* the
        // endpoint, which is the conventional look.
        refX={cap === 'triangle' || cap === 'arrow' ? 10 : 5}
        refY={5}
        markerUnits="strokeWidth"
      >
        <MarkerShape cap={cap} color={color} />
      </marker>
    ))}
  </defs>
);

/**
 * Renders every edge as SVG inside `.canvas-transform`, plus:
 *  - a transparent thick hit-proxy stroke per edge so thin lines are
 *    still easy to click;
 *  - a pale highlight underneath the selected edge;
 *  - 3 handles (start, bend midpoint, end) on the selected edge;
 *  - a dashed preview edge while a connect/move-end drag is in flight.
 *
 * The layer itself has `pointer-events: none`; individual child
 * elements re-enable events (hit-proxies: `stroke`, handles: `all`).
 * This keeps node drag/resize/click behaviour untouched.
 */
export const CanvasEdgesLayer = ({
  edges,
  nodes,
  selectedEdgeId,
  onSelectEdge,
  interactionState,
  previewEndpoints,
  onHandleMouseDown,
  onBodyMouseDown,
  onBodyDoubleClick,
}: Props) => {
  const nodesById = useMemo(() => {
    const m = new Map<string, CanvasNode>();
    for (const n of nodes) m.set(n.id, n);
    return m;
  }, [nodes]);

  const markers = useMarkerDefs(edges);

  // Resolve each edge's endpoints into absolute canvas coords. Auto-
  // anchored node-bound endpoints are shifted to their bbox-boundary
  // point toward the opposite endpoint, so edges visually terminate at
  // node edges rather than piercing into node centers. Additionally, if
  // the endpoint carries a visible arrow cap we inset it by a small gap
  // so the marker has clear space outside the node (otherwise the cap
  // sits flush against the node border and visually disappears).
  const resolved = useMemo(() => {
    return edges.map((edge) => {
      const approxS = resolveEndpoint(edge.source, nodesById);
      const approxT = resolveEndpoint(edge.target, nodesById);
      let s = resolveEndpointToward(edge.source, nodesById, approxT);
      let t = resolveEndpointToward(edge.target, nodesById, approxS);
      const head = edge.arrowHead ?? 'triangle';
      const tail = edge.arrowTail ?? 'none';
      if (edge.target.kind === 'node' && head !== 'none') {
        t = insetTowardOther(t, s, ARROW_NODE_GAP);
      }
      if (edge.source.kind === 'node' && tail !== 'none') {
        s = insetTowardOther(s, t, ARROW_NODE_GAP);
      }
      return { edge, s, t };
    });
  }, [edges, nodesById]);

  if (edges.length === 0 && !previewEndpoints) return null;

  return (
    <svg
      className="canvas-edges"
      width={1}
      height={1}
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        overflow: 'visible',
        pointerEvents: 'none',
      }}
    >
      <Markers markers={markers} />

      {resolved.map(({ edge, s, t }) => {
        const bend = edge.bend ?? 0;
        const d = buildPathData(s, t, bend);
        const stroke = { ...DEFAULT_STROKE, ...edge.stroke };
        const head = edge.arrowHead ?? 'triangle';
        const tail = edge.arrowTail ?? 'none';
        const isSelected = edge.id === selectedEdgeId;
        // While this edge's source/target is being dragged live, the
        // stored endpoint already reflects the in-progress state (we
        // push updates history-silently from useEdgeInteraction), so
        // no special case needed here — the path re-renders naturally.

        return (
          <g key={edge.id}>
            {/* Wide transparent hit target so thin lines stay clickable.
                A mousedown on the body both selects the edge AND starts
                a "move the whole edge" drag via onBodyMouseDown. Free
                endpoints translate with the cursor; node-bound endpoints
                stay anchored to their node. Clicks without drag resolve
                to plain "select" because no move-update fires and
                commitHistory is a no-op when state is unchanged. The
                midpoint bend handle (rendered on top via EdgeHandles)
                still captures its own mousedowns for curving. */}
            <path
              d={d}
              fill="none"
              stroke="transparent"
              strokeWidth={HIT_PROXY_WIDTH}
              vectorEffect="non-scaling-stroke"
              style={{
                pointerEvents: 'stroke',
                cursor: 'grab',
              }}
              onMouseDown={(e) => {
                // Selecting an edge steals the mousedown so it doesn't
                // bubble up into the canvas-container's blank-click
                // deselect logic.
                e.stopPropagation();
                onSelectEdge?.(edge.id);
                onBodyMouseDown?.(edge.id, e);
              }}
              onDoubleClick={(e) => {
                // Swallow so the canvas-container's blank-area dbl-click
                // handler (which opens the new-node context menu) doesn't
                // fire. The parent opens the edge-label editor instead.
                e.stopPropagation();
                onBodyDoubleClick?.(edge.id, e);
              }}
            />
            {/* Selection underlay: soft blue tint, rendered under the
                real stroke so the edge's own color still reads. Scales
                with the canvas (no non-scaling-stroke) so it stays
                visibly wider than the main stroke at every zoom — a
                fixed-pixel underlay would get visually swallowed once
                the zoomed-up main stroke caught up in width. */}
            {isSelected && (
              <path
                d={d}
                fill="none"
                stroke={SELECTION_COLOR}
                strokeOpacity={0.35}
                strokeWidth={(stroke.width ?? DEFAULT_STROKE.width) + 6}
                strokeLinecap="round"
              />
            )}
            {/* Handles for the selected edge. Rendered BEFORE the visible
                stroke so the stroke (and more importantly its markers)
                paint on top — without this, the white-filled target
                handle circle sits over the arrow-head marker and the
                triangle visually disappears. The stroke itself passes
                through the handle but is only a few pixels wide, so
                the handle's ring stays clearly readable. */}
            {isSelected && onHandleMouseDown && (
              <EdgeHandles
                edge={edge}
                s={s}
                t={t}
                onHandleMouseDown={(handle, e) =>
                  onHandleMouseDown(edge.id, handle, e, { s, t })
                }
              />
            )}
            {/* Visible stroke. Linecap is "butt" whenever the matching
                end has an arrow marker — SVG places the marker's refPoint
                AT the path endpoint, so a rounded cap (radius = half
                stroke width) would poke forward *past* the triangle tip
                and make the arrow look slightly disconnected from the
                line. Using "butt" ends the stroke flush with the path
                endpoint so the triangle's tip becomes the exact rightmost
                point of the arrow. Edges with no caps at all keep "round"
                for their nicer free-end look.

                No vectorEffect here: content strokes should scale with
                canvas zoom so the marker (also sized in user-space via
                markerUnits="strokeWidth") stays proportional to the line
                at every zoom. With non-scaling-stroke the line would
                stay thin while the marker ballooned, producing the
                cartoonishly oversized arrow reported earlier. */}
            <path
              d={d}
              fill="none"
              stroke={stroke.color}
              strokeWidth={stroke.width}
              strokeDasharray={strokeDasharray(stroke.style)}
              strokeLinecap={head !== 'none' || tail !== 'none' ? 'butt' : 'round'}
              markerEnd={head !== 'none' ? `url(#${capId('edge-head', head, stroke.color)})` : undefined}
              markerStart={tail !== 'none' ? `url(#${capId('edge-tail', tail, stroke.color)})` : undefined}
            />
          </g>
        );
      })}

      {previewEndpoints && (
        <PreviewEdge
          s={previewEndpoints.s}
          t={previewEndpoints.t}
          highlightNodeId={interactionState?.kind === 'connect' || interactionState?.kind === 'move-end'
            ? interactionState.hoverNodeId
            : null}
          nodesById={nodesById}
        />
      )}
    </svg>
  );
};

/**
 * Three handles — start (source), bend midpoint, end (target) —
 * rendered for the currently selected edge. Each handle intercepts
 * mousedown so the interaction hook can begin a drag.
 */
const EdgeHandles = ({
  edge,
  s,
  t,
  onHandleMouseDown,
}: {
  edge: CanvasEdge;
  s: Point;
  t: Point;
  onHandleMouseDown: (handle: 'source' | 'target' | 'bend', e: React.MouseEvent) => void;
}) => {
  const bend = edge.bend ?? 0;
  const mid = bendHandlePoint(s, t, bend);

  const handleStyle: React.CSSProperties = {
    pointerEvents: 'all',
    cursor: 'grab',
  };

  return (
    <>
      <circle
        cx={s.x}
        cy={s.y}
        r={HANDLE_RADIUS}
        fill="#ffffff"
        stroke={SELECTION_COLOR}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        style={handleStyle}
        onMouseDown={(e) => {
          e.stopPropagation();
          onHandleMouseDown('source', e);
        }}
      />
      <circle
        cx={mid.x}
        cy={mid.y}
        r={HANDLE_RADIUS - 0.5}
        fill="#ffffff"
        stroke={SELECTION_COLOR}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        style={handleStyle}
        onMouseDown={(e) => {
          e.stopPropagation();
          onHandleMouseDown('bend', e);
        }}
      />
      <circle
        cx={t.x}
        cy={t.y}
        r={HANDLE_RADIUS}
        fill="#ffffff"
        stroke={SELECTION_COLOR}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        style={handleStyle}
        onMouseDown={(e) => {
          e.stopPropagation();
          onHandleMouseDown('target', e);
        }}
      />
    </>
  );
};

/**
 * Dashed preview line rendered while the user is drawing a new edge
 * or dragging an existing endpoint. A faint outline on the hover
 * target node confirms a successful drop will bind to it.
 */
const PreviewEdge = ({
  s,
  t,
  highlightNodeId,
  nodesById,
}: {
  s: Point;
  t: Point;
  highlightNodeId: string | null;
  nodesById: Map<string, CanvasNode>;
}) => {
  const d = `M ${s.x} ${s.y} L ${t.x} ${t.y}`;
  const node = highlightNodeId ? nodesById.get(highlightNodeId) : null;
  return (
    <>
      <path
        d={d}
        fill="none"
        stroke={SELECTION_COLOR}
        strokeWidth={1.5}
        strokeDasharray="5 3"
        // "butt" to match the committed-edge rendering: since there's a
        // marker at the end, a rounded cap would poke past the triangle
        // tip (see the committed-edge comment for the full explanation).
        strokeLinecap="butt"
        markerEnd={`url(#${capId('edge-head', 'triangle', SELECTION_COLOR)})`}
        style={{ pointerEvents: 'none' }}
      />
      {/* Also register the preview's triangle-on-blue marker so
          marker-end="url(#…)" resolves. Duplicate marker defs are
          harmless; the <defs> above won't include this combo unless an
          edge already uses blue. Shape + sizing mirrors the committed-
          edge markers so preview and final arrow look identical. */}
      <defs>
        <marker
          id={capId('edge-head', 'triangle', SELECTION_COLOR)}
          markerWidth={4}
          markerHeight={4}
          viewBox="0 0 10 10"
          orient="auto"
          refX={10}
          refY={5}
          markerUnits="strokeWidth"
        >
          <path d="M0,1.5 L10,5 L0,8.5 z" fill={SELECTION_COLOR} />
        </marker>
      </defs>
      {node && (
        <rect
          x={node.x - 2}
          y={node.y - 2}
          width={node.width + 4}
          height={node.height + 4}
          fill="none"
          stroke={SELECTION_COLOR}
          strokeWidth={1.5}
          strokeDasharray="4 3"
          vectorEffect="non-scaling-stroke"
          style={{ pointerEvents: 'none' }}
          rx={6}
        />
      )}
    </>
  );
};
