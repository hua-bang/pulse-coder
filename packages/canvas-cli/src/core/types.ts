export type NodeType = 'file' | 'terminal' | 'frame';
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

export interface CanvasSaveData {
  nodes: CanvasNode[];
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
