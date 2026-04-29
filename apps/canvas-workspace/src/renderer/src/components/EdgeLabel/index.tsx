import { useEffect, useMemo, useRef, useState } from 'react';
import './index.css';
import type { CanvasEdge, CanvasNode, CanvasTransform } from '../../types';
import {
  bendHandlePoint,
  resolveEndpoint,
  resolveEndpointToward,
} from '../../utils/edgeFactory';

/**
 * Inline label on an edge.
 *
 * Positioned at the edge's visual midpoint (the bend-handle point, which
 * coincides with the curve at t=0.5 — see `bendHandlePoint`). Rendered in
 * the overlay layer rather than inside the edges SVG so the label text is
 * a real DOM element — easy to style, wrap, and edit via a plain <input>.
 *
 * Two display modes:
 *  - view  → static text "chip" sitting on top of the line, readable at
 *            any zoom thanks to being outside .canvas-transform.
 *  - edit  → single-line input. Enter or blur commits, Escape cancels.
 *
 * Clicks are absorbed (stopPropagation) so tapping the label doesn't
 * deselect the edge or bubble into the canvas blank-click handler.
 */
interface Props {
  edge: CanvasEdge;
  nodes: CanvasNode[];
  transform: CanvasTransform;
  isEditing: boolean;
  onStartEdit: (id: string) => void;
  onCommit: (id: string, label: string) => void;
  onCancel: () => void;
}

export const EdgeLabel = ({
  edge,
  nodes,
  transform,
  isEditing,
  onStartEdit,
  onCommit,
  onCancel,
}: Props) => {
  const [draft, setDraft] = useState(edge.label ?? '');
  const inputRef = useRef<HTMLInputElement>(null);

  // Re-seed the draft whenever we (re)enter edit mode or the stored
  // label changes behind us. Without this, reopening after canceling a
  // previous edit would show stale text from the aborted session.
  useEffect(() => {
    if (isEditing) {
      setDraft(edge.label ?? '');
    }
  }, [isEditing, edge.label]);

  useEffect(() => {
    if (!isEditing) return;
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  }, [isEditing]);

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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onCommit(edge.id, draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onCancel();
    }
  };

  // Shrink the chip with the canvas when zoomed out so it doesn't dwarf the
  // (also-shrinking) edge stroke. Cap at 1 so it never grows past native size
  // when zoomed in, and floor at 0.6 so deep zoom-out keeps the text legible.
  const labelScale = Math.min(1, Math.max(0.6, transform.scale));

  return (
    <div
      className={`edge-label${isEditing ? ' edge-label--editing' : ''}`}
      style={{
        left: screenPos.x,
        top: screenPos.y,
        ['--edge-label-scale' as string]: labelScale,
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.stopPropagation()}
      onDoubleClick={(e) => {
        // Intentionally swallow the dblclick so it doesn't bubble up
        // into the canvas-container handler (which spawns the
        // new-node context menu on a blank-canvas dbl-click).
        e.stopPropagation();
        if (!isEditing) onStartEdit(edge.id);
      }}
    >
      {isEditing ? (
        <input
          ref={inputRef}
          className="edge-label-input"
          value={draft}
          // Commit empty-string labels as "no label" by handing the
          // raw value straight through; the parent decides how to
          // normalize (it strips empty strings so the field goes back
          // to `undefined` on the edge).
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => onCommit(edge.id, draft)}
          placeholder="Label"
          // Avoid the browser trying to autofill edge labels.
          autoComplete="off"
          spellCheck={false}
        />
      ) : (
        <span className="edge-label-text">{edge.label}</span>
      )}
    </div>
  );
};
