export interface CanvasNode {
  id: string;
  type: "file" | "terminal" | "frame";
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: FileNodeData | TerminalNodeData | FrameNodeData;
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
}

export interface FrameNodeData {
  color: string;
  label?: string;
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
    ) => Promise<{ ok: boolean; mergedNodes?: CanvasNode[]; error?: string }>;
    load: (
      id: string
    ) => Promise<{ ok: boolean; data?: CanvasSaveData | null; error?: string }>;
    list: () => Promise<{ ok: boolean; ids?: string[]; error?: string }>;
    delete: (id: string) => Promise<{ ok: boolean; error?: string }>;
    getDir: (id: string) => Promise<{ ok: boolean; dir?: string; error?: string }>;
    watchWorkspace: (workspaceId: string) => Promise<{ ok: boolean }>;
  };
  file: FileApi;
  dialog: DialogApi;
  skills: SkillsApi;
}

declare global {
  interface Window {
    canvasWorkspace: CanvasWorkspaceApi;
  }
}
