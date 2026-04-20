import { useCallback, useEffect, useRef, useState } from 'react';
import './index.css';
import type { CanvasNode, ShapeNodeData } from '../../types';

interface Props {
  node: CanvasNode;
  onSelect: (id: string) => void;
  onDragStart: (e: React.MouseEvent, node: CanvasNode) => void;
}

/**
 * Shape node body. Renders a single SVG primitive (rect or ellipse) that
 * fills the node box. The entire surface is a drag handle, mirroring the
 * chromeless image/text bodies.
 *
 * The stroke is drawn inside the viewport by insetting the geometry by
 * half the stroke width — without the inset, SVG centers the stroke on
 * the edge so half of it clips outside the node bounds.
 */
export const ShapeNodeBody = ({ node, onSelect, onDragStart }: Props) => {
  const data = node.data as ShapeNodeData;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      onSelect(node.id);
      onDragStart(e, node);
    },
    [node, onSelect, onDragStart],
  );

  const w = Math.max(1, node.width);
  const h = Math.max(1, node.height);
  const sw = Math.max(0, data.strokeWidth ?? 0);
  const inset = sw / 2;

  return (
    <div className="shape-node-body" onMouseDown={handleMouseDown}>
      <svg
        className="shape-node-svg"
        width="100%"
        height="100%"
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
      >
        {data.kind === 'ellipse' ? (
          <ellipse
            cx={w / 2}
            cy={h / 2}
            rx={Math.max(0, w / 2 - inset)}
            ry={Math.max(0, h / 2 - inset)}
            fill={data.fill}
            stroke={data.stroke}
            strokeWidth={sw}
          />
        ) : (
          <rect
            x={inset}
            y={inset}
            width={Math.max(0, w - sw)}
            height={Math.max(0, h - sw)}
            fill={data.fill}
            stroke={data.stroke}
            strokeWidth={sw}
          />
        )}
      </svg>
    </div>
  );
};

/* ---- Style picker (floating palette for selected shape) ---- */

const FILL_PRESETS: Array<{ name: string; value: string }> = [
  { name: 'Transparent', value: 'transparent' },
  { name: 'White', value: '#FFFFFF' },
  { name: 'Slate', value: '#E8EEF7' },
  { name: 'Red', value: '#FAD4CF' },
  { name: 'Orange', value: '#FADFC1' },
  { name: 'Yellow', value: '#F7EBC0' },
  { name: 'Green', value: '#CFE7D9' },
  { name: 'Teal', value: '#C9E5E8' },
  { name: 'Blue', value: '#CFDDF3' },
  { name: 'Purple', value: '#D9D0EE' },
  { name: 'Pink', value: '#F2D0E0' },
  { name: 'Gray', value: '#D9DCE2' },
];

const STROKE_PRESETS: Array<{ name: string; value: string }> = [
  { name: 'None', value: 'transparent' },
  { name: 'Black', value: '#1F2328' },
  { name: 'Gray', value: '#6E7681' },
  { name: 'Red', value: '#D7402B' },
  { name: 'Orange', value: '#D97A1F' },
  { name: 'Yellow', value: '#C9A31A' },
  { name: 'Green', value: '#2F8F5A' },
  { name: 'Teal', value: '#2E8A94' },
  { name: 'Blue', value: '#5B7CBF' },
  { name: 'Purple', value: '#7957C4' },
  { name: 'Pink', value: '#C94F8C' },
];

const STROKE_WIDTHS: number[] = [0, 1, 2, 4, 6];

interface StylePickerProps {
  node: CanvasNode;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
}

export const ShapeStylePicker = ({ node, onUpdate }: StylePickerProps) => {
  const data = node.data as ShapeNodeData;
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handle = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, [open]);

  const patch = useCallback(
    (next: Partial<ShapeNodeData>) => {
      onUpdate(node.id, { data: { ...data, ...next } });
    },
    [data, node.id, onUpdate],
  );

  return (
    <div
      ref={rootRef}
      className={`shape-style-trigger${open ? ' shape-style-trigger--open' : ''}`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        className="shape-style-preview"
        title="Shape style"
        onClick={() => setOpen((v) => !v)}
      >
        <span
          className="shape-style-swatch"
          style={{
            background: data.fill === 'transparent' ? 'none' : data.fill,
            borderColor: data.stroke === 'transparent' ? 'rgba(0,0,0,0.15)' : data.stroke,
            borderStyle: data.fill === 'transparent' ? 'dashed' : 'solid',
            borderRadius: data.kind === 'ellipse' ? '50%' : '3px',
          }}
        />
      </button>
      {open && (
        <div className="shape-style-popover">
          <div className="shape-style-row">
            <span className="shape-style-label">Fill</span>
            <div className="shape-style-swatches">
              {FILL_PRESETS.map((p) => (
                <button
                  key={p.name}
                  className={`shape-style-swatch-btn${data.fill === p.value ? ' shape-style-swatch-btn--active' : ''}`}
                  title={p.name}
                  style={{
                    background: p.value === 'transparent' ? 'none' : p.value,
                  }}
                  onClick={() => patch({ fill: p.value })}
                >
                  {p.value === 'transparent' && <span className="shape-style-none-slash" />}
                </button>
              ))}
            </div>
          </div>
          <div className="shape-style-row">
            <span className="shape-style-label">Stroke</span>
            <div className="shape-style-swatches">
              {STROKE_PRESETS.map((p) => (
                <button
                  key={p.name}
                  className={`shape-style-swatch-btn${data.stroke === p.value ? ' shape-style-swatch-btn--active' : ''}`}
                  title={p.name}
                  style={{
                    background: p.value === 'transparent' ? 'none' : p.value,
                  }}
                  onClick={() => patch({ stroke: p.value })}
                >
                  {p.value === 'transparent' && <span className="shape-style-none-slash" />}
                </button>
              ))}
            </div>
          </div>
          <div className="shape-style-row">
            <span className="shape-style-label">Width</span>
            <div className="shape-style-widths">
              {STROKE_WIDTHS.map((w) => (
                <button
                  key={w}
                  className={`shape-style-width-btn${data.strokeWidth === w ? ' shape-style-width-btn--active' : ''}`}
                  title={`${w}px`}
                  onClick={() => patch({ strokeWidth: w })}
                >
                  {w === 0 ? (
                    <span className="shape-style-none-slash shape-style-none-slash--inline" />
                  ) : (
                    <span
                      className="shape-style-width-bar"
                      style={{ height: Math.max(1, w) }}
                    />
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
