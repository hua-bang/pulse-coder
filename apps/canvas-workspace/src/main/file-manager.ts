import { ipcMain, dialog, BrowserWindow } from "electron";
import { promises as fs } from "fs";
import { join, basename } from "path";
import { homedir } from "os";

const IGNORED_DIRS = new Set([
  'node_modules', '.git', '.DS_Store', 'dist', '.next', '.nuxt', '__pycache__', '.venv',
]);

interface DirEntry {
  name: string;
  type: 'file' | 'dir';
  children?: DirEntry[];
}

const listDirRecursive = async (
  dirPath: string,
  depth: number,
  maxDepth: number
): Promise<DirEntry[]> => {
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  const result: DirEntry[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
    if (entry.isDirectory()) {
      const item: DirEntry = { name: entry.name, type: 'dir' };
      if (depth < maxDepth) {
        try {
          item.children = await listDirRecursive(join(dirPath, entry.name), depth + 1, maxDepth);
        } catch {
          item.children = [];
        }
      }
      result.push(item);
    } else {
      result.push({ name: entry.name, type: 'file' });
    }
  }
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return result;
};

const STORE_DIR = join(homedir(), ".pulse-coder", "canvas");

const getNotesDir = (workspaceId: string) =>
  join(STORE_DIR, workspaceId, "notes");

export const setupFileManagerIpc = () => {
  // Create a new note file in the workspace-scoped notes directory
  ipcMain.handle(
    "file:createNote",
    async (_event, payload: { workspaceId?: string; name?: string }) => {
      try {
        const wsId = payload.workspaceId ?? "default";
        const notesDir = getNotesDir(wsId);
        await fs.mkdir(notesDir, { recursive: true });
        const timestamp = Date.now();
        const safeName = payload.name
          ? payload.name.replace(/[^a-zA-Z0-9_\- ]/g, "").trim()
          : "";
        const fileName = safeName
          ? `${safeName}.md`
          : `note-${timestamp}.md`;
        const filePath = join(notesDir, fileName);
        await fs.writeFile(filePath, "", "utf-8");
        return { ok: true, filePath, fileName };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  // Read a file
  ipcMain.handle(
    "file:read",
    async (_event, payload: { filePath: string }) => {
      try {
        const content = await fs.readFile(payload.filePath, "utf-8");
        return { ok: true, content };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  // Write a file
  ipcMain.handle(
    "file:write",
    async (_event, payload: { filePath: string; content: string }) => {
      try {
        await fs.writeFile(payload.filePath, payload.content, "utf-8");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  // List directory (recursive, max depth)
  ipcMain.handle(
    "file:listDir",
    async (_event, payload: { dirPath: string; maxDepth?: number }) => {
      try {
        const entries = await listDirRecursive(payload.dirPath, 0, payload.maxDepth ?? 3);
        return { ok: true, entries };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  // Open folder dialog
  ipcMain.handle("dialog:openFolder", async (_event) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: "Select Project Folder",
      properties: ["openDirectory"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return { ok: true, folderPath: result.filePaths[0] };
  });

  // Open file dialog
  ipcMain.handle("file:openDialog", async (_event) => {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win!, {
      title: "Open File",
      filters: [
        { name: "Markdown", extensions: ["md", "markdown", "txt"] },
        { name: "All Files", extensions: ["*"] }
      ],
      properties: ["openFile"]
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const filePath = result.filePaths[0];
    try {
      const content = await fs.readFile(filePath, "utf-8");
      const fileName = basename(filePath);
      return { ok: true, filePath, fileName, content };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  // Save-as dialog
  ipcMain.handle(
    "file:saveAsDialog",
    async (_event, payload: { defaultName?: string; content: string }) => {
      const win = BrowserWindow.getFocusedWindow();
      const result = await dialog.showSaveDialog(win!, {
        title: "Save As",
        defaultPath: payload.defaultName || "untitled.md",
        filters: [
          { name: "Markdown", extensions: ["md"] },
          { name: "All Files", extensions: ["*"] }
        ]
      });
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true };
      }
      try {
        await fs.writeFile(result.filePath, payload.content, "utf-8");
        const fileName = basename(result.filePath);
        return { ok: true, filePath: result.filePath, fileName };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );
};
