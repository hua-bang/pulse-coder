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
}

const DEFAULT_STROKE: Required<EdgeStroke> = {
  color: '#1f2328',
  width: 2.4,
  style: 'solid',
};

const SELECTION_COLOR = '#2a7fff';
const HIT_PROXY_WIDTH = 10;
const HANDLE_RADIUS = 5;

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
      return <path d="M0,0 L10,5 L0,10 z" fill={color} />;
    case 'arrow':
      return (
        <path
          d="M0,0 L10,5 L0,10"
          fill="none"
          stroke={color}
          strokeWidth={1.5}
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
        markerWidth={12}
        markerHeight={12}
        viewBox="0 0 10 10"
        orient={side === 'head' ? 'auto' : 'auto-start-reverse'}
        refX={cap === 'triangle' ? 10 : 5}
        refY={5}
        markerUnits="userSpaceOnUse"
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
  // node edges rather than piercing into node centers.
  const resolved = useMemo(() => {
    return edges.map((edge) => {
      const approxS = resolveEndpoint(edge.source, nodesById);
      const approxT = resolveEndpoint(edge.target, nodesById);
      const s = resolveEndpointToward(edge.source, nodesById, approxT);
      const t = resolveEndpointToward(edge.target, nodesById, approxS);
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
                a bend drag — users reported that having to grab the
                tiny midpoint handle to curve a line felt awkward, so
                we now treat "grab anywhere on the stroke" as a shortcut
                to bending it. A click that doesn't move still resolves
                to "just select" because no bend-update fires and
                commitHistory is a no-op when state is unchanged. */}
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
                onHandleMouseDown?.(edge.id, 'bend', e, { s, t });
              }}
            />
            {/* Selection underlay: soft blue tint, rendered under the
                real stroke so the edge's own color still reads. */}
            {isSelected && (
              <path
                d={d}
                fill="none"
                stroke={SELECTION_COLOR}
                strokeOpacity={0.35}
                strokeWidth={(stroke.width ?? DEFAULT_STROKE.width) + 6}
                strokeLinecap="round"
                vectorEffect="non-scaling-stroke"
              />
            )}
            {/* Visible stroke. */}
            <path
              d={d}
              fill="none"
              stroke={stroke.color}
              strokeWidth={stroke.width}
              strokeDasharray={strokeDasharray(stroke.style)}
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
              markerEnd={head !== 'none' ? `url(#${capId('edge-head', head, stroke.color)})` : undefined}
              markerStart={tail !== 'none' ? `url(#${capId('edge-tail', tail, stroke.color)})` : undefined}
            />
            {/* Handles for the selected edge only. Rendered as a last
                child so they sit visually above the stroke. */}
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
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
        markerEnd={`url(#${capId('edge-head', 'triangle', SELECTION_COLOR)})`}
        style={{ pointerEvents: 'none' }}
      />
      {/* Also register the preview's triangle-on-blue marker so
          marker-end="url(#…)" resolves. Duplicate marker defs are
          harmless; the <defs> above won't include this combo unless an
          edge already uses blue. */}
      <defs>
        <marker
          id={capId('edge-head', 'triangle', SELECTION_COLOR)}
          markerWidth={12}
          markerHeight={12}
          viewBox="0 0 10 10"
          orient="auto"
          refX={10}
          refY={5}
          markerUnits="userSpaceOnUse"
        >
          <path d="M0,0 L10,5 L0,10 z" fill={SELECTION_COLOR} />
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
