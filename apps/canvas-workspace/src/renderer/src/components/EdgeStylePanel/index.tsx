import { useEffect, useMemo, useState } from 'react';
import './index.css';
import type {
  CanvasEdge,
  CanvasNode,
  CanvasTransform,
  EdgeArrowCap,
  EdgeStroke,
} from '../../types';
import {
  bendHandlePoint,
  resolveEndpoint,
  resolveEndpointToward,
} from '../../utils/edgeFactory';

/**
 * A compact floating panel, shown when an edge is selected, that lets
 * the user tweak its stroke color, width, dash style, arrow head / tail,
 * and delete it. Positioned above the edge's midpoint in screen space so
 * it tracks the edge as nodes move / the canvas pans.
 *
 * Surface chrome is a single row of "chips" — one per property — each
 * showing the edge's *current* value. Clicking a chip expands a second
 * row inside the same popover with the full option list for that
 * property. Only one section can be open at a time; selecting a value
 * (or clicking outside the panel) collapses it back to the chip row.
 * This keeps the panel's default footprint small so it doesn't swallow
 * the edge it's attached to.
 *
 * Clicks inside the panel are stopped from bubbling up into the canvas
 * click handler so changing style doesn't accidentally deselect the
 * edge we're editing.
 */
interface Props {
  edge: CanvasEdge;
  nodes: CanvasNode[];
  transform: CanvasTransform;
  onUpdate: (id: string, patch: Partial<CanvasEdge>) => void;
  onRemove: (id: string) => void;
}

type Section = 'color' | 'width' | 'style' | 'head' | 'tail';

// Palette mirrors tldraw-style defaults — 1 neutral + 6 hues that read well on the
// off-white canvas background at both zoom extremes. First entry matches
// DEFAULT_STROKE.color in CanvasEdgesLayer.
const COLORS: string[] = [
  '#1f2328',
  '#e5484d',
  '#f76808',
  '#ffba18',
  '#30a46c',
  '#0091ff',
  '#8e4ec6',
];

const WIDTHS: Array<{ label: string; value: number }> = [
  { label: 'S', value: 1.6 },
  { label: 'M', value: 2.4 },
  { label: 'L', value: 3.6 },
];

const STYLES: Array<NonNullable<EdgeStroke['style']>> = ['solid', 'dashed', 'dotted'];

const CAPS: EdgeArrowCap[] = ['none', 'triangle', 'arrow', 'dot', 'bar'];

const strokeDasharrayFor = (style: EdgeStroke['style']): string | undefined => {
  switch (style) {
    case 'dashed': return '6 4';
    case 'dotted': return '1.5 3';
    case 'solid':
    default:       return undefined;
  }
};

/**
 * Small SVG preview for a single arrow cap. Used in the head/tail
 * picker buttons — a short line with the cap on the right-hand side.
 */
const CapPreview = ({ cap, color, side }: { cap: EdgeArrowCap; color: string; side: 'head' | 'tail' }) => {
  const size = 18;
  // For "tail" we mirror so the cap visually sits on the start of the stroke.
  const x1 = side === 'head' ? 2 : 16;
  const x2 = side === 'head' ? 14 : 4;
  return (
    <svg width={size} height={size} viewBox="0 0 18 18">
      <line x1={x1} y1={9} x2={x2} y2={9} stroke={color} strokeWidth={1.4} strokeLinecap="round" />
      {cap === 'triangle' && (
        <path
          d={side === 'head' ? 'M10,5 L16,9 L10,13 Z' : 'M8,5 L2,9 L8,13 Z'}
          fill={color}
        />
      )}
      {cap === 'arrow' && (
        <path
          d={side === 'head' ? 'M10,5 L16,9 L10,13' : 'M8,5 L2,9 L8,13'}
          fill="none"
          stroke={color}
          strokeWidth={1.4}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {cap === 'dot' && (
        <circle cx={side === 'head' ? 15 : 3} cy={9} r={2.5} fill={color} />
      )}
      {cap === 'bar' && (
        <rect x={side === 'head' ? 14 : 3} y={4} width={1.6} height={10} fill={color} />
      )}
      {cap === 'none' && (
        <circle cx={side === 'head' ? 15 : 3} cy={9} r={2.2} fill="none" stroke={color} strokeWidth={1} />
      )}
    </svg>
  );
};

/**
 * Inline preview for the width chip — a short line rendered at the
 * edge's current stroke width (clamped to what the chip can display).
 */
const WidthPreview = ({ width }: { width: number }) => (
  <svg width="22" height="14" viewBox="0 0 22 14">
    <line
      x1={3}
      y1={7}
      x2={19}
      y2={7}
      stroke="currentColor"
      strokeWidth={Math.min(width, 4)}
      strokeLinecap="round"
    />
  </svg>
);

/**
 * Inline preview for the style chip — a short line rendered in the
 * current dash pattern.
 */
const StylePreview = ({ style }: { style: EdgeStroke['style'] }) => (
  <svg width="22" height="14" viewBox="0 0 22 14">
    <line
      x1={3}
      y1={7}
      x2={19}
      y2={7}
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeDasharray={strokeDasharrayFor(style)}
    />
  </svg>
);

export const EdgeStylePanel = ({
  edge,
  nodes,
  transform,
  onUpdate,
  onRemove,
}: Props) => {
  const color = edge.stroke?.color ?? '#1f2328';
  const width = edge.stroke?.width ?? 2.4;
  const style = edge.stroke?.style ?? 'solid';
  const head: EdgeArrowCap = edge.arrowHead ?? 'triangle';
  const tail: EdgeArrowCap = edge.arrowTail ?? 'none';

  const [openSection, setOpenSection] = useState<Section | null>(null);
  // Collapse the popover whenever the selection switches to a different
  // edge — otherwise the old section would stay open against the fresh
  // current values, which feels confusing.
  useEffect(() => {
    setOpenSection(null);
  }, [edge.id]);

  // Resolve the edge's midpoint in canvas coords (accounts for bend),
  // then convert to screen coords via the current transform. The panel
  // sits inside `.canvas-container`, so transform.x/y (pan offset) map
  // directly to container-relative coordinates.
  const screenPos = useMemo(() => {
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    const approxS = resolveEndpoint(edge.source, nodesById);
    const approxT = resolveEndpoint(edge.target, nodesById);
    const s = resolveEndpointToward(edge.source, nodesById, approxT);
    const t = resolveEndpointToward(edge.target, nodesById, approxS);
    const mid = bendHandlePoint(s, t, edge.bend ?? 0);
    return {
      x: mid.x * transform.scale + transform.x,
      y: mid.y * transform.scale + transform.y,
    };
  }, [edge, nodes, transform]);

  const setStroke = (patch: Partial<EdgeStroke>) => {
    onUpdate(edge.id, { stroke: { ...edge.stroke, ...patch } });
  };

  const toggleSection = (section: Section) =>
    setOpenSection((current) => (current === section ? null : section));

  // Wrapper that picks a value AND collapses the popover. Selecting is
  // always a terminal action — the user rarely wants to pick twice in
  // a row from the same property, and auto-collapsing keeps the panel
  // footprint minimal.
  const choose = (fn: () => void) => {
    fn();
    setOpenSection(null);
  };

  const renderChip = (
    section: Section,
    title: string,
    children: React.ReactNode,
  ) => (
    <button
      className={`edge-chip${openSection === section ? ' edge-chip--active' : ''}`}
      onClick={() => toggleSection(section)}
      title={title}
    >
      {children}
    </button>
  );

  return (
    <div
      className="edge-style-panel"
      style={{ left: screenPos.x, top: screenPos.y }}
      // Stop propagation so our own clicks don't hit the canvas-level
      // blank-click handler (which would deselect the edge we're styling).
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div className="edge-style-chip-row">
        {renderChip(
          'color',
          `Color ${color}`,
          <span className="edge-chip-swatch" style={{ background: color }} />,
        )}
        {renderChip('width', `Width`, <WidthPreview width={width} />)}
        {renderChip('style', `Style ${style ?? 'solid'}`, <StylePreview style={style} />)}

        <div className="edge-style-divider" />

        {renderChip(
          'head',
          `Arrow end`,
          <CapPreview cap={head} color="currentColor" side="head" />,
        )}
        {renderChip(
          'tail',
          `Arrow start`,
          <CapPreview cap={tail} color="currentColor" side="tail" />,
        )}

        <div className="edge-style-divider" />

        <button
          className="edge-chip edge-chip--danger"
          onClick={() => onRemove(edge.id)}
          title="Delete edge"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <path
              d="M4 4l8 8M12 4L4 12"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            />
          </svg>
        </button>
      </div>

      {openSection && (
        <div className="edge-style-popover">
          {openSection === 'color' && (
            <div className="edge-style-row">
              {COLORS.map((c) => (
                <button
                  key={c}
                  className={`edge-style-swatch${c === color ? ' edge-style-swatch--active' : ''}`}
                  style={{ background: c }}
                  onClick={() => choose(() => setStroke({ color: c }))}
                  title={c}
                />
              ))}
            </div>
          )}

          {openSection === 'width' && (
            <div className="edge-style-row">
              {WIDTHS.map((w) => (
                <button
                  key={w.label}
                  className={`edge-style-btn${Math.abs(width - w.value) < 0.05 ? ' edge-style-btn--active' : ''}`}
                  onClick={() => choose(() => setStroke({ width: w.value }))}
                  title={`Width ${w.label}`}
                >
                  <svg width="26" height="18" viewBox="0 0 26 18">
                    <line
                      x1={3}
                      y1={9}
                      x2={23}
                      y2={9}
                      stroke="currentColor"
                      strokeWidth={w.value}
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              ))}
            </div>
          )}

          {openSection === 'style' && (
            <div className="edge-style-row">
              {STYLES.map((st) => (
                <button
                  key={st}
                  className={`edge-style-btn${st === style ? ' edge-style-btn--active' : ''}`}
                  onClick={() => choose(() => setStroke({ style: st }))}
                  title={st}
                >
                  <svg width="30" height="18" viewBox="0 0 30 18">
                    <line
                      x1={3}
                      y1={9}
                      x2={27}
                      y2={9}
                      stroke="currentColor"
                      strokeWidth={1.8}
                      strokeLinecap="round"
                      strokeDasharray={strokeDasharrayFor(st)}
                    />
                  </svg>
                </button>
              ))}
            </div>
          )}

          {openSection === 'head' && (
            <div className="edge-style-row edge-style-row--caps">
              {CAPS.map((c) => (
                <button
                  key={`head-${c}`}
                  className={`edge-style-btn edge-style-btn--cap${c === head ? ' edge-style-btn--active' : ''}`}
                  onClick={() => choose(() => onUpdate(edge.id, { arrowHead: c }))}
                  title={`End: ${c}`}
                >
                  <CapPreview cap={c} color="currentColor" side="head" />
                </button>
              ))}
            </div>
          )}

          {openSection === 'tail' && (
            <div className="edge-style-row edge-style-row--caps">
              {CAPS.map((c) => (
                <button
                  key={`tail-${c}`}
                  className={`edge-style-btn edge-style-btn--cap${c === tail ? ' edge-style-btn--active' : ''}`}
                  onClick={() => choose(() => onUpdate(edge.id, { arrowTail: c }))}
                  title={`Start: ${c}`}
                >
                  <CapPreview cap={c} color="currentColor" side="tail" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
