import { useCallback } from "react";
import "./index.css";
import type { CanvasNode, FrameNodeData, AgentNodeData, TextNodeData } from "../../types";
import type { ResizeEdge } from "../../hooks/useNodeResize";
import { FileNodeBody } from "../FileNodeBody";
import { TerminalNodeBody } from "../TerminalNodeBody";
import { FrameNodeBody, FrameColorPicker } from "../FrameNodeBody";
import { AgentNodeBody } from "../AgentNodeBody";
import { TextNodeBody, TextColorPicker } from "../TextNodeBody";
import { IframeNodeBody } from "../IframeNodeBody";
import { InfographicNodeBody } from "../InfographicNodeBody";

interface Props {
  node: CanvasNode;
  allNodes: CanvasNode[];
  rootFolder?: string;
  workspaceId?: string;
  workspaceName?: string;
  isDragging: boolean;
  isResizing: boolean;
  isSelected: boolean;
  isHighlighted: boolean;
  /** True while this node is within the short window after a canvas-cli edit. */
  isAgentEdited?: boolean;
  onDragStart: (e: React.MouseEvent, node: CanvasNode) => void;
  onResizeStart: (
    e: React.MouseEvent,
    nodeId: string,
    width: number,
    height: number,
    edge: ResizeEdge,
    minWidth?: number,
    minHeight?: number
  ) => void;
  onUpdate: (id: string, patch: Partial<CanvasNode>) => void;
  onRemove: (id: string) => void;
  onSelect: (id: string) => void;
  onFocus: (node: CanvasNode) => void;
}

export const CanvasNodeView = ({
  node,
  allNodes,
  rootFolder,
  workspaceId,
  workspaceName,
  isDragging,
  isResizing,
  isSelected,
  isHighlighted,
  isAgentEdited,
  onDragStart,
  onResizeStart,
  onUpdate,
  onRemove,
  onSelect,
  onFocus
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

  const handleFocus = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      onFocus(node);
    },
    [onFocus, node]
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
      if (node.type === "text") {
        // Dragging a resize handle on a text node switches it out of auto-size
        // mode so the dragged width/height becomes the authoritative frame.
        const data = node.data as TextNodeData;
        if (data.autoSize !== false) {
          onUpdate(node.id, { data: { ...data, autoSize: false } });
        }
        // Text labels should be shrinkable well below the standard 200×120
        // floor — a tiny tag is a valid shape.
        onResizeStart(e, node.id, node.width, node.height, edge, 40, 28);
        return;
      }
      onResizeStart(e, node.id, node.width, node.height, edge);
    },
    [onResizeStart, onUpdate, node.id, node.type, node.width, node.height, node.data]
  );

  const textAutoSize =
    node.type === "text" && (node.data as TextNodeData).autoSize !== false;

  const classes = [
    "canvas-node",
    `canvas-node--${node.type}`,
    isDragging && "canvas-node--dragging",
    isResizing && "canvas-node--resizing",
    isSelected && "canvas-node--selected",
    isHighlighted && "canvas-node--highlighted",
    isAgentEdited && "canvas-node--agent-edited",
    textAutoSize && "canvas-node--text-auto"
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={classes}
      style={{
        transform: `translate(${node.x}px, ${node.y}px)`,
        width: node.width,
        height: node.height,
        ...(node.type === 'frame'
          ? { '--frame-color': (node.data as FrameNodeData).color } as React.CSSProperties
          : {})
      }}
      onClick={handleNodeClick}
    >
      <div
        className="node-header"
        onMouseDown={handleHeaderMouseDown}
      >
        <span className={`node-type-badge node-type-badge--${node.type}`}>
          {node.type === "file" ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 3h10v10a1 1 0 01-1 1H4a1 1 0 01-1-1V3z" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5.5 7h5M5.5 9.5h3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            </svg>
          ) : node.type === "terminal" ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
              <path d="M4.5 7l2 1.5-2 1.5M8 10.5h3.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          ) : node.type === "frame" ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <rect x="4.5" y="4.5" width="7" height="7" rx="1" stroke="currentColor" strokeWidth="1" strokeDasharray="2 1.5" />
            </svg>
          ) : node.type === "text" ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <path d="M3 4h10M8 4v9M6 13h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          ) : node.type === "iframe" ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.3" />
              <path d="M2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
            </svg>
          ) : node.type === "infographic" ? (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" strokeWidth="1.3" />
              <path d="M5 11V7.5M8 11V5M11 11V9" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
            </svg>
          ) : (
            <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="5.5" r="3" stroke="currentColor" strokeWidth="1.3" />
              <path d="M4 14c0-2.2 1.8-4 4-4s4 1.8 4 4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
              <circle cx="6.5" cy="5" r="0.8" fill="currentColor" />
              <circle cx="9.5" cy="5" r="0.8" fill="currentColor" />
            </svg>
          )}
          {node.type === "agent" && (() => {
            const agentStatus = (node.data as AgentNodeData).status;
            if (!agentStatus || agentStatus === "idle") return null;
            return <span className={`node-status-dot node-status-dot--${agentStatus}`} />;
          })()}
        </span>
        <span
          className="node-title"
          contentEditable
          suppressContentEditableWarning
          spellCheck={false}
          onBlur={handleTitleChange}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {node.title}
        </span>
        {node.type === "frame" && (
          <FrameColorPicker node={node} onUpdate={onUpdate} />
        )}
        {node.type === "text" && (
          <TextColorPicker node={node} onUpdate={onUpdate} />
        )}
        <button className="node-focus" onClick={handleFocus} title="Focus">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="2" stroke="currentColor" strokeWidth="1.3" />
            <path d="M6 1v2M6 9v2M1 6h2M9 6h2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
        <button className="node-close" onClick={handleClose} title="Remove">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <div className="node-body" onMouseDown={(e) => e.stopPropagation()}>
        {node.type === "file" ? (
          <FileNodeBody node={node} onUpdate={onUpdate} workspaceId={workspaceId} />
        ) : node.type === "terminal" ? (
          <TerminalNodeBody node={node} allNodes={allNodes} rootFolder={rootFolder} workspaceId={workspaceId} workspaceName={workspaceName} onUpdate={onUpdate} />
        ) : node.type === "frame" ? (
          <FrameNodeBody node={node} onUpdate={onUpdate} />
        ) : node.type === "text" ? (
          <TextNodeBody
            node={node}
            onUpdate={onUpdate}
            isSelected={isSelected}
            onSelect={onSelect}
            onDragStart={onDragStart}
          />
        ) : node.type === "iframe" ? (
          <IframeNodeBody node={node} workspaceId={workspaceId} onUpdate={onUpdate} />
        ) : node.type === "infographic" ? (
          <InfographicNodeBody node={node} workspaceId={workspaceId} onUpdate={onUpdate} />
        ) : (
          <AgentNodeBody node={node} allNodes={allNodes} rootFolder={rootFolder} workspaceId={workspaceId} workspaceName={workspaceName} onUpdate={onUpdate} />
        )}
      </div>

      <div
        className="resize-handle resize-handle--right"
        onMouseDown={makeResizeHandler("right")}
      />
      {/* Text nodes grow vertically to fit content, so a bottom/corner
          handle would either do nothing or fight the auto-height. Offer only
          the right-edge handle as a wrap-width control. */}
      {node.type !== "text" && (
        <>
          <div
            className="resize-handle resize-handle--bottom"
            onMouseDown={makeResizeHandler("bottom")}
          />
          <div
            className="resize-handle resize-handle--corner"
            onMouseDown={makeResizeHandler("bottom-right")}
          />
        </>
      )}
    </div>
  );
};
