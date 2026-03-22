import { useCallback } from "react";
import type { CanvasNode } from "../types";
import type { ResizeEdge } from "../hooks/useNodeResize";
import { FileNodeBody } from "./FileNodeBody";
import { TerminalNodeBody } from "./TerminalNodeBody";

interface Props {
  node: CanvasNode;
  allNodes: CanvasNode[];
  rootFolder?: string;
  isDragging: boolean;
  isResizing: boolean;
  isSelected: boolean;
  onDragStart: (e: React.MouseEvent, node: CanvasNode) => void;
  onResizeStart: (
    e: React.MouseEvent,
    nodeId: string,
    width: number,
    height: number,
    edge: ResizeEdge
  ) => void;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
}

export const CanvasNodeView = ({
  node,
  allNodes,
  rootFolder,
  isDragging,
  isResizing,
  isSelected,
  onDragStart,
  onResizeStart,
  onUpdate,
  onRemove,
  onSelect
}: Props) => {
  const handleHeaderMouseDown = useCallback(
    (e: React.MouseEvent) => {
      onSelect(node.id);
      onDragStart(e, node);
    },
    [onSelect, onDragStart, node]
  );

  const handleNodeClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onSelect(node.id);
    },
    [onSelect, node.id]
  );

  const handleClose = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onRemove(node.id);
    },
    [onRemove, node.id]
  );

  const handleTitleChange = useCallback(
    (e: React.FocusEvent<HTMLSpanElement>) => {
      const newTitle = e.currentTarget.textContent?.trim();
      if (newTitle && newTitle !== node.title) {
        onUpdate(node.id, { title: newTitle });
      }
    },
    [onUpdate, node.id, node.title]
  );

  const makeResizeHandler = useCallback(
    (edge: ResizeEdge) => (e: React.MouseEvent) => {
      onResizeStart(e, node.id, node.width, node.height, edge);
    },
    [onResizeStart, node.id, node.width, node.height]
  );

  const classes = [
    "canvas-node",
    `canvas-node--${node.type}`,
    isDragging && "canvas-node--dragging",
    isResizing && "canvas-node--resizing",
    isSelected && "canvas-node--selected"
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      style={{
        transform: `translate(${node.x}px, ${node.y}px)`,
        width: node.width,
        height: node.height
      }}
      onClick={handleNodeClick}
    >
      <div className="node-header" onMouseDown={handleHeaderMouseDown}>
        <span className={`node-type-badge node-type-badge--${node.type}`}>
          {node.type === "file" ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 3h10v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3z" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5.5 7h5M5.5 9.5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M4.5 7l2 1.5-2 1.5M8 10.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </span>
        <span
          className="node-title"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={handleTitleChange}
        >
          {node.title}
        </span>
        <button className="node-close" onClick={handleClose} title="Remove">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="node-body">
        {node.type === "file" ? (
          <FileNodeBody node={node} onUpdate={onUpdate} />
        ) : (
          <TerminalNodeBody node={node} allNodes={allNodes} rootFolder={rootFolder} onUpdate={onUpdate} />
        )}
      </div>

      <div
        className="resize-handle resize-handle--right"
        onMouseDown={makeResizeHandler("right")}
      />
      <div
        className="resize-handle resize-handle--bottom"
        onMouseDown={makeResizeHandler("bottom")}
      />
      <div
        className="resize-handle resize-handle--corner"
        onMouseDown={makeResizeHandler("bottom-right")}
      />
    </div>
  );
};
