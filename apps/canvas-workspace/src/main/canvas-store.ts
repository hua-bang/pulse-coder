import { ipcMain } from "electron";
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";

const STORE_DIR = join(homedir(), ".pulse-coder", "canvas");
const MANIFEST_ID = '__workspaces__';

const AGENTS_MD_TEMPLATE = `# Canvas Agent Config

## Purpose
<!-- Describe what this workspace is for -->

## Instructions
<!-- Conventions, style, or constraints for agents working in this workspace -->

---

<!-- canvas:auto-start -->
<!-- canvas:auto-end -->
`;

/** Manifest stays as a flat file; all other workspaces live in subdirectories. */
const getFilePath = (id: string): string => {
  if (id === MANIFEST_ID) {
    return join(STORE_DIR, `${MANIFEST_ID}.json`);
  }
  return join(STORE_DIR, id, 'canvas.json');
};

export const getWorkspaceDir = (id: string): string =>
  join(STORE_DIR, id);

/** Migrate old flat `{id}.json` → `{id}/canvas.json` if needed. */
const migrateIfNeeded = async (id: string): Promise<void> => {
  const newPath = getFilePath(id);
  const oldPath = join(STORE_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
  try {
    await fs.access(newPath);
    return; // already in new format
  } catch {
    // new path missing — check for old flat file
  }
  try {
    const raw = await fs.readFile(oldPath, 'utf-8');
    await fs.mkdir(getWorkspaceDir(id), { recursive: true });
    await fs.writeFile(newPath, raw, 'utf-8');
    await fs.unlink(oldPath).catch(() => undefined);
  } catch {
    // no old file either — fresh workspace, nothing to migrate
  }
};

/** Ensure workspace directory exists and seed AGENTS.md if absent. */
const ensureWorkspaceDir = async (id: string): Promise<void> => {
  const dir = getWorkspaceDir(id);
  await fs.mkdir(dir, { recursive: true });
  const agentsPath = join(dir, 'AGENTS.md');
  const hasAgents = await fs.access(agentsPath).then(() => true).catch(() => false);
  if (!hasAgents) {
    await fs.writeFile(agentsPath, AGENTS_MD_TEMPLATE, 'utf-8');
  }
};

/** Old global notes directory (pre-refactor). */
const LEGACY_NOTES_DIR = join(STORE_DIR, 'notes');

interface CanvasNode {
  type: string;
  data?: { filePath?: string; [k: string]: unknown };
  [k: string]: unknown;
}

interface CanvasSaveData {
  nodes?: CanvasNode[];
  [k: string]: unknown;
}

/**
 * Migrate file-node paths that still point to the old global notes dir
 * into the per-workspace notes dir. Moves the actual files on disk and
 * returns true when the data was modified (caller should re-save).
 */
const migrateNotePaths = async (
  id: string,
  data: CanvasSaveData,
): Promise<boolean> => {
  if (!Array.isArray(data.nodes)) return false;
  const newNotesDir = join(STORE_DIR, id, 'notes');
  let dirty = false;
  for (const node of data.nodes) {
    if (node.type !== 'file' || !node.data?.filePath) continue;
    const fp: string = node.data.filePath;
    if (!fp.startsWith(LEGACY_NOTES_DIR + '/') && !fp.startsWith(LEGACY_NOTES_DIR + '\\')) continue;
    const fileName = fp.split(/[\\/]/).pop()!;
    const newPath = join(newNotesDir, fileName);
    try {
      await fs.mkdir(newNotesDir, { recursive: true });
      await fs.copyFile(fp, newPath);
      await fs.unlink(fp).catch(() => undefined);
    } catch {
      // file may already be missing; still update the stored path
    }
    node.data = { ...node.data, filePath: newPath };
    dirty = true;
  }
  return dirty;
};

/**
 * Merge external changes (e.g. from canvas-cli) into the data being saved.
 *
 * Strategy:
 * - Nodes on disk whose ID is NOT in the in-memory save → added externally → keep them
 * - Nodes on disk whose ID IS in the in-memory save → Electron owns these → use in-memory version
 * - Nodes in memory but not on disk → newly created in Electron, or CLI deleted them → keep them
 *
 * This ensures CLI-added nodes survive Electron's debounced saves without
 * introducing the race conditions that the old file-watcher approach had.
 */
const mergeExternalNodes = async (
  id: string,
  inMemoryData: CanvasSaveData,
): Promise<CanvasSaveData> => {
  try {
    const raw = await fs.readFile(getFilePath(id), 'utf-8');
    const diskData = JSON.parse(raw) as CanvasSaveData;
    const diskNodes = Array.isArray(diskData.nodes) ? diskData.nodes : [];
    const memoryNodes = Array.isArray(inMemoryData.nodes) ? inMemoryData.nodes : [];

    const memoryIds = new Set(memoryNodes.map(n => n.id));
    const externalNodes = diskNodes.filter(n => n.id && !memoryIds.has(n.id));

    if (externalNodes.length === 0) return inMemoryData;

    return {
      ...inMemoryData,
      nodes: [...memoryNodes, ...externalNodes],
    };
  } catch {
    // No existing file on disk or parse error — nothing to merge
    return inMemoryData;
  }
};

export const setupCanvasStoreIpc = () => {
  ipcMain.handle(
    'canvas:save',
    async (_event, payload: { id: string; data: unknown }) => {
      try {
        await fs.mkdir(STORE_DIR, { recursive: true });
        if (payload.id === MANIFEST_ID) {
          await fs.writeFile(
            getFilePath(MANIFEST_ID),
            JSON.stringify(payload.data, null, 2),
            'utf-8'
          );
        } else {
          await ensureWorkspaceDir(payload.id);
          // Merge CLI-added nodes before writing
          const merged = await mergeExternalNodes(
            payload.id,
            payload.data as CanvasSaveData,
          );
          await fs.writeFile(
            getFilePath(payload.id),
            JSON.stringify(merged, null, 2),
            'utf-8'
          );
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    'canvas:load',
    async (_event, payload: { id: string }) => {
      try {
        if (payload.id !== MANIFEST_ID) {
          await migrateIfNeeded(payload.id);
          await ensureWorkspaceDir(payload.id);
        }
        const filePath = getFilePath(payload.id);
        const raw = await fs.readFile(filePath, 'utf-8');
        const data: CanvasSaveData = JSON.parse(raw);
        if (payload.id !== MANIFEST_ID) {
          const dirty = await migrateNotePaths(payload.id, data);
          if (dirty) {
            await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
          }
        }
        return { ok: true, data };
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { ok: true, data: null };
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle('canvas:list', async () => {
    try {
      await fs.mkdir(STORE_DIR, { recursive: true });
      const entries = await fs.readdir(STORE_DIR, { withFileTypes: true });
      const ids = entries
        .filter((e) => e.isDirectory() && e.name !== MANIFEST_ID)
        .map((e) => e.name);
      // Also include legacy flat files that haven't been migrated yet
      const flatIds = entries
        .filter(
          (e) =>
            e.isFile() &&
            e.name.endsWith('.json') &&
            !e.name.startsWith(MANIFEST_ID)
        )
        .map((e) => e.name.replace(/\.json$/, ''));
      return { ok: true, ids: [...new Set([...ids, ...flatIds])] };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    'canvas:delete',
    async (_event, payload: { id: string }) => {
      try {
        if (payload.id === MANIFEST_ID) return { ok: false, error: 'Cannot delete manifest' };
        const dir = getWorkspaceDir(payload.id);
        await fs.rm(dir, { recursive: true, force: true });
        // Also remove old flat file if it still exists
        const oldPath = join(STORE_DIR, `${payload.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.json`);
        await fs.unlink(oldPath).catch(() => undefined);
        return { ok: true };
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return { ok: true };
        return { ok: false, error: String(err) };
      }
    }
  );

  /** Returns the absolute directory path for a workspace. */
  ipcMain.handle(
    'canvas:getDir',
    async (_event, payload: { id: string }) => {
      try {
        if (payload.id === MANIFEST_ID) {
          return { ok: false, error: 'No dir for manifest' };
        }
        await ensureWorkspaceDir(payload.id);
        return { ok: true, dir: getWorkspaceDir(payload.id) };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );
};
