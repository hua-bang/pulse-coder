export interface CanvasNode {
  id: string;
  type: "file" | "terminal" | "frame" | "agent" | "text" | "iframe" | "infographic";
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
    | InfographicNodeData;
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
 * Embeds an external web page via an <iframe>. Some sites block embedding
 * via X-Frame-Options / CSP frame-ancestors — those will fail to render and
 * the user can click "Open externally" to escape into the system browser.
 */
export interface IframeNodeData {
  /** Full URL (including protocol) to load in the iframe. Empty = show URL input. */
  url: string;
}

/**
 * LLM-generated visual content (akin to Claude's "Visual and interactive
 * content" feature). The node captures a short prompt, dispatches it to the
 * Canvas Agent's generation service in the main process, and renders the
 * result inside an isolated `<webview>` (HTML) or inline `<svg>` (SVG).
 *
 * Content is stored on disk under
 * `~/.pulse-coder/canvas/{workspaceId}/infographics/{nodeId}.{svg|html}`
 * rather than inline in canvas.json — infographic HTML can be large and we
 * don't want it inflating every canvas snapshot.
 */
export interface InfographicNodeData {
  /** 'html' → sandboxed webview via srcdoc; 'svg' → inline <svg>. */
  kind: "html" | "svg";
  /**
   * Absolute path to the on-disk file holding the rendered content.
   * Empty before the first successful generation.
   */
  filePath: string;
  /** User prompt that produced the current content. */
  sourcePrompt: string;
  /** Generation status — drives the body's empty / loading / ready UI. */
  status?: "empty" | "generating" | "ready" | "error";
  /** Error message when `status === 'error'`. */
  error?: string;
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
    mentionedWorkspaceIds?: string[]
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
  infographic: InfographicApi;
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

export interface InfographicApi {
  /**
   * Run the Canvas Agent's LLM to produce HTML/SVG content from a prompt,
   * persist it to the workspace's `infographics/` directory, and return the
   * rendered content. The caller is responsible for updating the node's
   * `data` (filePath, status) afterwards.
   */
  generate: (
    workspaceId: string,
    nodeId: string,
    prompt: string,
    kind?: "html" | "svg",
  ) => Promise<{
    ok: boolean;
    kind?: "html" | "svg";
    content?: string;
    filePath?: string;
    error?: string;
  }>;
  /** Read a previously-generated infographic file. */
  read: (
    workspaceId: string,
    nodeId: string,
    kind: "html" | "svg",
  ) => Promise<{ ok: boolean; content?: string; error?: string }>;
}

declare global {
  interface Window {
    canvasWorkspace: CanvasWorkspaceApi;
  }
}
