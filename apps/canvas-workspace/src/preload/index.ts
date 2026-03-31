import { contextBridge, ipcRenderer } from "electron";

const sendLog = (level: string, message: string, details?: string) => {
  ipcRenderer.send("app:log", { level, message, details });
};

window.addEventListener("error", (event) => {
  sendLog("renderer", "window error", String(event.error ?? event.message));
});

window.addEventListener("unhandledrejection", (event) => {
  sendLog("renderer", "unhandledrejection", String(event.reason));
});

contextBridge.exposeInMainWorld("canvasWorkspace", {
  version: "0.1.0",

  pty: {
    spawn: (id: string, cols?: number, rows?: number, cwd?: string, workspaceId?: string) =>
      ipcRenderer.invoke("pty:spawn", { id, cols, rows, cwd, workspaceId }),

    write: (id: string, data: string) =>
      ipcRenderer.send("pty:write", { id, data }),

    resize: (id: string, cols: number, rows: number) =>
      ipcRenderer.send("pty:resize", { id, cols, rows }),

    kill: (id: string) => ipcRenderer.send("pty:kill", { id }),

    getCwd: (id: string) => ipcRenderer.invoke("pty:getCwd", { id }),

    onData: (id: string, callback: (data: string) => void) => {
      const channel = `pty:data:${id}`;
      const handler = (_event: Electron.IpcRendererEvent, data: string) =>
        callback(data);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    },

    onExit: (id: string, callback: (exitCode: number) => void) => {
      const channel = `pty:exit:${id}`;
      const handler = (
        _event: Electron.IpcRendererEvent,
        exitCode: number
      ) => callback(exitCode);
      ipcRenderer.on(channel, handler);
      return () => {
        ipcRenderer.removeListener(channel, handler);
      };
    }
  },

  store: {
    save: (id: string, data: unknown) =>
      ipcRenderer.invoke("canvas:save", { id, data }),

    load: (id: string) =>
      ipcRenderer.invoke("canvas:load", { id }),

    list: () => ipcRenderer.invoke("canvas:list"),

    delete: (id: string) =>
      ipcRenderer.invoke("canvas:delete", { id }),

    getDir: (id: string) =>
      ipcRenderer.invoke("canvas:getDir", { id }),

    watchWorkspace: (workspaceId: string) =>
      ipcRenderer.invoke("canvas:watchWorkspace", { workspaceId })
  },

  file: {
    createNote: (workspaceId?: string, name?: string) =>
      ipcRenderer.invoke("file:createNote", { workspaceId, name }),

    read: (filePath: string) =>
      ipcRenderer.invoke("file:read", { filePath }),

    write: (filePath: string, content: string) =>
      ipcRenderer.invoke("file:write", { filePath, content }),

    listDir: (dirPath: string, maxDepth?: number) =>
      ipcRenderer.invoke("file:listDir", { dirPath, maxDepth }),

    openDialog: () => ipcRenderer.invoke("file:openDialog"),

    saveAsDialog: (defaultName: string, content: string) =>
      ipcRenderer.invoke("file:saveAsDialog", { defaultName, content }),

    saveImage: (workspaceId: string | undefined, data: string, ext?: string) =>
      ipcRenderer.invoke("file:saveImage", { workspaceId, data, ext }),

    onChanged: (callback: (filePath: string, content: string) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        payload: { filePath: string; content: string }
      ) => callback(payload.filePath, payload.content);
      ipcRenderer.on("canvas:file-changed", handler);
      return () => ipcRenderer.removeListener("canvas:file-changed", handler);
    }
  },

  dialog: {
    openFolder: () => ipcRenderer.invoke("dialog:openFolder")
  }
});
