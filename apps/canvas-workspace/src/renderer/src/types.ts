export interface CanvasNode {
  id: string;
  type: "file" | "terminal";
  title: string;
  x: number;
  y: number;
  width: number;
  height: number;
  data: FileNodeData | TerminalNodeData;
}

export interface FileNodeData {
  filePath: string;
  content: string;
}

export interface TerminalNodeData {
  sessionId: string;
  scrollback?: string;
  cwd?: string;
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

export interface CanvasWorkspaceApi {
  version: string;
  pty: {
    spawn: (
      id: string,
      cols?: number,
      rows?: number,
      cwd?: string
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
  };
}

declare global {
  interface Window {
    canvasWorkspace: CanvasWorkspaceApi;
  }
}
