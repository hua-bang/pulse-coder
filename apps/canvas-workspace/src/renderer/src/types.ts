export interface CanvasNode {
  id: string;
  type: "file" | "terminal" | "frame" | "agent" | "text" | "iframe" | "image" | "shape" | "mindmap";
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data:
    | FileNodeData
    | TerminalNodeData
    | FrameNodeData
    | AgentNodeData
    | TextNodeData
    | IframeNodeData
    | ImageNodeData
    | ShapeNodeData
    | MindmapNodeData;
  /** Epoch millis of last mutation; used for cross-process merge. */
  updatedAt?: number;
}

export interface FileNodeData {
  filePath: string;
  content: string;
  saved?: boolean;
  modified?: boolean;
}

export interface TerminalNodeData {
  sessionId: string;
  scrollback?: string;
  cwd?: string;
  /** Shell command to execute automatically after the terminal spawns. */
  initialCommand?: string;
}

export interface FrameNodeData {
  color: string;
  label?: string;
}

export interface AgentNodeData {
  sessionId: string;
  scrollback?: string;
  cwd?: string;
  agentType: string;
  status?: 'idle' | 'running' | 'done' | 'error';
  agentArgs?: string;
  /** Short prompt passed directly as a CLI argument. */
  inlinePrompt?: string;
  /** Relative path to a prompt file in cwd for long prompts. */
  promptFile?: string;
}

/**
 * TLDRAW-style free-form text label on the canvas.
 *
 * Content is markdown (supports **bold**, *italic*, ++underline++, lists,
 * headings, etc.). Colors are applied via inline styles so they persist
 * across reloads. `backgroundColor: 'transparent'` renders a chrome-free
 * label.
 *
 * `autoSize` controls how the wrapper dimensions are interpreted:
 *  - `true` (default): width/height track the rendered content via CSS
 *    `max-content`. Useful while typing so the node hugs its text.
 *  - `false`: the user has manually resized the node; `width`/`height`
 *    become a hard frame and long text wraps within. Set by the resize
 *    drag handles.
 */
export interface TextNodeData {
  content: string;
  textColor: string;
  backgroundColor: string;
  /** Optional font size in px; defaults to 18 when unset. */
  fontSize?: number;
  /** When false, the user has dragged a resize handle — respect width/height. */
  autoSize?: boolean;
}

/**
 * Embeds an external web page or renders raw HTML.
 *
 * `mode: 'url'` (default) loads a remote page via Electron `<webview>`.
 * `mode: 'html'` renders user-supplied HTML in a sandboxed `<iframe srcdoc>`.
 *
 * Some sites block embedding via X-Frame-Options / CSP frame-ancestors —
 * those will fail to render and the user can click "Open externally" to
 * escape into the system browser.
 */
export interface IframeNodeData {
  /** Full URL (including protocol) to load in the iframe. Empty = show URL input. */
  url: string;
  /** Raw HTML content to render when `mode` is `'html'` or `'ai'`. */
  html?: string;
  /** `'url'` embeds a remote page; `'html'` renders raw HTML; `'ai'` generates HTML from a prompt. */
  mode?: 'url' | 'html' | 'ai';
  /** The prompt used to generate HTML when `mode` is `'ai'`. */
  prompt?: string;
}

/**
 * A free-form image pinned to the canvas. Created by pasting (Ctrl/Cmd+V)
 * image data onto the canvas; the bytes are persisted to the workspace
 * images directory via `file:saveImage` and referenced by absolute path.
 *
 * Rendered with no header/border chrome so the picture is the whole node.
 * The entire body acts as the drag handle (mirroring TextNodeBody).
 */
export interface ImageNodeData {
  /** Absolute path on disk to the saved image file. */
  filePath: string;
}

/**
 * A primitive geometric shape drawn on the canvas. Rendered as an inline
 * SVG that fills the node box, so the same storage powers both rect and
 * ellipse (and any future primitives). Colors are stored as hex strings
 * or "transparent"; stroke width is in CSS pixels at scale=1.
 *
 * `text` is an optional free-form label centered inside the shape. It
 * is rendered via an HTML `contenteditable` overlay (not SVG text) so it
 * wraps like any other DOM text and inherits the canvas's font stack.
 */
export interface ShapeNodeData {
  kind: "rect" | "rounded-rect" | "ellipse" | "triangle" | "diamond" | "hexagon" | "star";
  fill: string;
  stroke: string;
  strokeWidth: number;
  text?: string;
  textColor?: string;
  /** Font size in px. Defaults to 16 when unset. */
  fontSize?: number;
}

/**
 * Heptabase-style mindmap card.
 *
 * The whole mindmap lives inside ONE canvas node — branches and children
 * are stored in a recursive `MindmapTopic` tree under `data.root`, not as
 * separate `CanvasNode`s connected by `CanvasEdge`s. This keeps the
 * structural relationships (parent/child) distinct from free-form canvas
 * connections drawn by the user between different nodes.
 *
 * Layout is deterministic: given the tree, `layoutMindmap` produces the
 * on-screen positions, so we never persist x/y for individual topics —
 * only the tree, which is cheap to round-trip through JSON storage.
 */
export interface MindmapTopic {
  /** Stable id — unique within the containing mindmap only. */
  id: string;
  text: string;
  children: MindmapTopic[];
  /** When true, the subtree is hidden (and its descendants are skipped
   *  by layout). Applies only to non-root topics. */
  collapsed?: boolean;
  /** Optional per-topic color override (hex). Defaults to a branch color
   *  derived from the topic's root-child index. */
  color?: string;
}

export interface MindmapNodeData {
  root: MindmapTopic;
  /** Layout direction. v1 supports `'right'` (root on the left, children
   *  growing rightward); other values are reserved for future modes. */
  layout: 'right';
  /** Bumped on every topic add/remove/rename — lets external observers
   *  (canvas-cli, agent) diff mindmaps without structural equality. */
  rev?: number;
}

export interface CanvasTransform {
  x: number;
  y: number;
  scale: number;
}

/**
 * One end of a `CanvasEdge`.
 *
 * `node`  → the endpoint tracks a node's anchor; the actual screen position
 *           is computed each render from the node's x/y/width/height.
 * `point` → the endpoint is a free canvas coordinate (no node binding).
 *           Used when the user drags an endpoint into empty space, or when
 *           a bound node is deleted and we degrade instead of cascade-delete.
 */
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

/**
 * A connection drawn between two endpoints on the canvas.
 *
 * Edges are tldraw-style: they are first-class shapes, not pure
 * "relations between nodes". Either endpoint can be free
 * (`{ kind: 'point', x, y }`) so users can draw arrows into empty
 * space; when a bound node is deleted, the renderer degrades the
 * affected endpoint to a free point rather than removing the edge.
 *
 * `bend` is a single signed scalar: 0 = straight, +N = pixels of
 * perpendicular offset from the source→target midpoint (toward the
 * normal's positive direction), -N = the other side. This keeps the
 * geometry representable as a single-control quadratic Bezier and
 * matches tldraw's arrow storage.
 *
 * `payload` is a free-form dictionary keyed by the edge's `kind` —
 * e.g. `kind: 'context'` edges can stash prompt-injection hints for
 * the canvas agent, `kind: 'data'` edges a transformer config, etc.
 * Everything stored must be JSON-safe; it round-trips through
 * canvas-store as-is.
 */
export interface CanvasEdge {
  id: string;
  source: EdgeEndpoint;
  target: EdgeEndpoint;
  bend?: number;
  arrowHead?: EdgeArrowCap;
  arrowTail?: EdgeArrowCap;
  stroke?: EdgeStroke;
  label?: string;
  kind?: string;
  payload?: Record<string, unknown>;
  /** Epoch millis of last mutation; used for cross-process merge. */
  updatedAt?: number;
}

export interface CanvasSaveData {
  nodes: CanvasNode[];
  /** Connections between nodes. Optional for backwards compatibility with
   *  older canvas.json files that pre-date connections. */
  edges?: CanvasEdge[];
  transform: CanvasTransform;
  savedAt: string;
}

export interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  children?: DirEntry[];
}

export interface FileApi {
  createNote: (
    workspaceId?: string,
    name?: string
  ) => Promise<{ ok: boolean; filePath?: string; fileName?: string; error?: string }>;
  read: (
    filePath: string
  ) => Promise<{ ok: boolean; content?: string; error?: string }>;
  write: (
    filePath: string,
    content: string
  ) => Promise<{ ok: boolean; error?: string }>;
  listDir: (
    dirPath: string,
    maxDepth?: number
  ) => Promise<{ ok: boolean; entries?: DirEntry[]; error?: string }>;
  openDialog: () => Promise<{
    ok: boolean;
    canceled?: boolean;
    filePath?: string;
    fileName?: string;
    content?: string;
    error?: string;
  }>;
  saveAsDialog: (
    defaultName: string,
    content: string
  ) => Promise<{
    ok: boolean;
    canceled?: boolean;
    filePath?: string;
    fileName?: string;
    error?: string;
  }>;
  saveImage: (
    workspaceId: string | undefined,
    data: string,
    ext?: string
  ) => Promise<{ ok: boolean; filePath?: string; fileName?: string; error?: string }>;
  exportImage: (
    defaultName: string,
    data: string,
    ext?: string
  ) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; fileName?: string; error?: string }>;
  onChanged: (callback: (filePath: string, content: string) => void) => () => void;
}

export interface DialogApi {
  openFolder: () => Promise<{ ok: boolean; canceled?: boolean; folderPath?: string; error?: string }>;
}

export interface SkillsInstallResult {
  ok: boolean;
  skillsInstalled: boolean;
  skillsPath?: string;
  cliInstalled: boolean;
  manualCommand?: string | null;
  cliError?: string | null;
  error?: string;
}

export interface SkillsApi {
  install: () => Promise<SkillsInstallResult>;
}

export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface AgentContextNodeRef {
  id: string;
  title: string;
  type: CanvasNode['type'];
}

export interface AgentRequestContext {
  executionMode?: 'auto' | 'ask';
  scope?: 'current_canvas' | 'selected_nodes';
  selectedNodes?: AgentContextNodeRef[];
  quickAction?: string;
}

export interface AgentSessionInfo {
  sessionId: string;
  date: string;
  messageCount: number;
  isCurrent: boolean;
  preview?: string;
}

export interface CrossWorkspaceSessionGroup {
  workspaceId: string;
  workspaceName: string;
  sessions: AgentSessionInfo[];
}

export interface AgentApi {
  chat: (
    workspaceId: string,
    message: string,
    mentionedWorkspaceIds?: string[],
    requestContext?: AgentRequestContext
  ) => Promise<{ ok: boolean; sessionId?: string; error?: string }>;
  onTextDelta: (
    sessionId: string,
    callback: (delta: string) => void
  ) => () => void;
  onChatComplete: (
    sessionId: string,
    callback: (result: { ok: boolean; response?: string; error?: string }) => void
  ) => () => void;
  onToolCall: (
    sessionId: string,
    callback: (data: { name: string; args: any }) => void
  ) => () => void;
  onToolResult: (
    sessionId: string,
    callback: (data: { name: string; result: string }) => void
  ) => () => void;
  onClarifyRequest: (
    sessionId: string,
    callback: (data: { id: string; question: string; context?: string }) => void
  ) => () => void;
  answerClarification: (
    sessionId: string,
    requestId: string,
    answer: string
  ) => Promise<{ ok: boolean; error?: string }>;
  abort: (sessionId: string) => Promise<{ ok: boolean; error?: string }>;
  getStatus: (
    workspaceId: string
  ) => Promise<{ ok: boolean; active: boolean; messageCount: number }>;
  getHistory: (
    workspaceId: string
  ) => Promise<{ ok: boolean; messages?: AgentChatMessage[] }>;
  listSessions: (
    workspaceId: string
  ) => Promise<{ ok: boolean; sessions?: AgentSessionInfo[]; error?: string }>;
  newSession: (
    workspaceId: string
  ) => Promise<{ ok: boolean; error?: string }>;
  loadSession: (
    workspaceId: string,
    sessionId: string
  ) => Promise<{ ok: boolean; messages?: AgentChatMessage[]; error?: string }>;
  listAllSessions: (
    workspaceNames: Record<string, string>,
  ) => Promise<{ ok: boolean; groups?: CrossWorkspaceSessionGroup[]; error?: string }>;
  loadCrossWorkspaceSession: (
    targetWorkspaceId: string,
    sourceWorkspaceId: string,
    sessionId: string,
  ) => Promise<{ ok: boolean; messages?: AgentChatMessage[]; error?: string }>;
  activate: (workspaceId: string) => Promise<{ ok: boolean; error?: string }>;
  deactivate: (workspaceId: string) => Promise<{ ok: boolean; error?: string }>;
}

export interface CanvasWorkspaceApi {
  version: string;
  pty: {
    spawn: (
      id: string,
      cols?: number,
      rows?: number,
      cwd?: string,
      workspaceId?: string
    ) => Promise<{ ok: boolean; pid?: number; error?: string; reused?: boolean }>;
    write: (id: string, data: string) => void;
    resize: (id: string, cols: number, rows: number) => void;
    kill: (id: string) => void;
    getCwd: (id: string) => Promise<{ ok: boolean; cwd?: string | null }>;
    onData: (id: string, callback: (data: string) => void) => () => void;
    onExit: (id: string, callback: (exitCode: number) => void) => () => void;
  };
  store: {
    save: (
      id: string,
      data: unknown
    ) => Promise<{ ok: boolean; error?: string }>;
    load: (
      id: string
    ) => Promise<{ ok: boolean; data?: CanvasSaveData | null; error?: string }>;
    list: () => Promise<{ ok: boolean; ids?: string[]; error?: string }>;
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
    getDir: (id: string) => Promise<{ ok: boolean; dir?: string; error?: string }>;
    exportWorkspace: (
      id: string,
      name: string
    ) => Promise<{ ok: boolean; canceled?: boolean; filePath?: string; fileCount?: number; error?: string }>;
    importWorkspace: () => Promise<{
      ok: boolean;
      canceled?: boolean;
      workspaceId?: string;
      workspaceName?: string;
      fileCount?: number;
      error?: string;
    }>;
    watchWorkspace: (workspaceId: string) => Promise<{ ok: boolean }>;
    onExternalUpdate: (
      callback: (event: {
        workspaceId: string;
        nodeIds: string[];
        kind?: "create" | "update" | "delete";
        source: string;
      }) => void
    ) => () => void;
  };
  file: FileApi;
  dialog: DialogApi;
  skills: SkillsApi;
  agent: AgentApi;
  iframe: IframeApi;
  llm: LlmApi;
}

export interface LlmApi {
  /** One-shot generation — returns full HTML when complete. */
  generateHTML: (prompt: string) => Promise<{ ok: boolean; html?: string; error?: string }>;
  /** Start a streaming generation — returns a requestId to subscribe to deltas. */
  streamHTML: (prompt: string) => Promise<{ ok: boolean; requestId?: string; error?: string }>;
  /** Subscribe to incremental text chunks during streaming generation. Returns unsubscribe fn. */
  onHTMLDelta: (requestId: string, callback: (delta: string) => void) => () => void;
  /** Subscribe to generation completion. Returns unsubscribe fn. */
  onHTMLComplete: (requestId: string, callback: (result: { ok: boolean; html?: string; error?: string }) => void) => () => void;
}

export interface IframeApi {
  registerWebview: (
    workspaceId: string,
    nodeId: string,
    webContentsId: number,
  ) => Promise<{ ok: boolean }>;
  unregisterWebview: (
    workspaceId: string,
    nodeId: string,
  ) => Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    canvasWorkspace: CanvasWorkspaceApi;
  }
}
