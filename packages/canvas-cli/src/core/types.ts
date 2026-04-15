export type NodeType = 'file' | 'terminal' | 'frame' | 'agent';
export type NodeCapability = 'read' | 'write' | 'exec';

export interface CanvasNodeData {
  filePath?: string;
  content?: string;
  saved?: boolean;
  modified?: boolean;
  scrollback?: string;
  cwd?: string;
  sessionId?: string;
  color?: string;
  label?: string;
  [key: string]: unknown;
}

export interface CanvasNode {
  id: string;
  type: NodeType;
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: CanvasNodeData;
  /**
   * Epoch millis of last mutation for this node. Used by the Electron main
   * process to merge concurrent writes from canvas-cli and the renderer
   * without losing the fresher version. Optional for backwards compatibility
   * with canvases written before this field was introduced.
   */
  updatedAt?: number;
}

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

// ─── Edges (connections between / around nodes) ─────────────────────
//
// Edges live at the workspace level alongside nodes. They are
// optional in `CanvasSaveData` for backwards compatibility with
// canvas.json files written before the edge feature shipped.

export type EdgeAnchor = 'top' | 'right' | 'bottom' | 'left' | 'auto';

export type EdgeEndpoint =
  | { kind: 'node'; nodeId: string; anchor?: EdgeAnchor }
  | { kind: 'point'; x: number; y: number };

export type EdgeArrowCap = 'none' | 'triangle' | 'arrow' | 'dot' | 'bar';

export interface EdgeStroke {
  color?: string;
  width?: number;
  style?: 'solid' | 'dashed' | 'dotted';
}

export interface CanvasEdge {
  id: string;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  /** Peak perpendicular offset of the rendered curve. 0 = straight line. */
  bend?: number;
  arrowHead?: EdgeArrowCap;
  arrowTail?: EdgeArrowCap;
  stroke?: EdgeStroke;
  label?: string;
  /** Optional semantic tag for downstream consumers (agent, layout, etc). */
  kind?: string;
  /** Free-form extension slot mirroring `CanvasNodeData`. */
  payload?: Record<string, unknown>;
  updatedAt?: number;
}

export interface CanvasSaveData {
  nodes: CanvasNode[];
  edges?: CanvasEdge[];
  transform: CanvasTransform;
  savedAt: string;
}

export interface WorkspaceEntry {
  id: string;
  name: string;
}

export interface WorkspaceManifest {
  workspaces: WorkspaceEntry[];
  activeId?: string;
}

export interface NodeReadResult {
  type: NodeType;
  capabilities: NodeCapability[];
  [key: string]: unknown;
}

export type Result<T = void> =
  | { ok: true; data: T }
  | { ok: false; error: string };
