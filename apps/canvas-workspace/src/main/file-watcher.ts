import { ipcMain, BrowserWindow } from 'electron';
import { watch, FSWatcher, promises as fs } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');
const DEBOUNCE_MS = 300;

let activeWatcher: FSWatcher | null = null;
let activeWorkspaceId: string | null = null;
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

function sendToRenderer(channel: string, payload: unknown): void {
  BrowserWindow.getAllWindows()[0]?.webContents.send(channel, payload);
}

function stopWatcher(): void {
  if (activeWatcher) {
    activeWatcher.close();
    activeWatcher = null;
  }
  activeWorkspaceId = null;
  debounceTimers.forEach((t) => clearTimeout(t));
  debounceTimers.clear();
}

function startWatcher(workspaceId: string): void {
  stopWatcher();

  const notesDir = join(STORE_DIR, workspaceId, 'notes');

  void fs.mkdir(notesDir, { recursive: true }).then(() => {
    activeWorkspaceId = workspaceId;

    try {
      activeWatcher = watch(notesDir, { recursive: false }, (_eventType: string, filename: string | null) => {
        if (!filename || !filename.endsWith('.md')) return;

        const filePath = join(notesDir, filename);

        // Debounce per file to coalesce rapid write events
        const existing = debounceTimers.get(filePath);
        if (existing) clearTimeout(existing);

        debounceTimers.set(
          filePath,
          setTimeout(() => {
            debounceTimers.delete(filePath);
            void fs.readFile(filePath, 'utf-8')
              .then((content: string) => {
                sendToRenderer('canvas:file-changed', { filePath, content });
              })
              .catch((_err: unknown) => {
                // File deleted or unreadable — ignore
              });
          }, DEBOUNCE_MS)
        );
      });

      activeWatcher.on('error', (err: unknown) => {
        console.warn('[FileWatcher] Watch error:', err);
      });

      console.log(`[FileWatcher] Watching ${notesDir}`);
    } catch (err) {
      console.warn('[FileWatcher] Could not start watcher for', notesDir, err);
    }
  });
}

export function setupFileWatcherIpc(): void {
  ipcMain.handle(
    'canvas:watchWorkspace',
    (_event: unknown, { workspaceId }: { workspaceId: string }) => {
      if (workspaceId === activeWorkspaceId) return { ok: true };
      startWatcher(workspaceId);
      return { ok: true };
    }
  );
}

export function teardownFileWatcher(): void {
  stopWatcher();
}
