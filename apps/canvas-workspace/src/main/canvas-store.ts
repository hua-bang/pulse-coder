import { ipcMain, BrowserWindow } from "electron";
import { promises as fs, watch as fsWatch, FSWatcher } from "fs";
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
  id?: string;
  type: string;
  data?: { filePath?: string; [k: string]: unknown };
  updatedAt?: number;
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
 * Track node IDs that Electron has seen (loaded or merged in) per workspace.
 * This lets us distinguish "CLI added a new node" (ID never seen before)
 * from "user deleted a node" (ID was seen, now missing from memory).
 */
const knownNodeIds = new Map<string, Set<string>>();

/**
 * Merge external changes (e.g. from canvas-cli) into the data being saved.
 *
 * Two merge rules are applied, in order:
 *
 *   1. Per-node "newer wins" by `updatedAt`: if a node exists in both the
 *      in-memory snapshot and the on-disk snapshot, the one with the greater
 *      `updatedAt` wins. This protects canvas-cli writes from being clobbered
 *      by stale renderer saves (e.g. the terminal scrollback autosave timer
 *      firing right after the CLI updated a file node).
 *
 *   2. Add disk-only nodes whose IDs have NEVER been seen by Electron. This
 *      is how canvas-cli creates show up. Disk-only nodes whose IDs *are*
 *      known were deleted in the UI and must not be re-added.
 */
const isEnoent = (err: unknown): boolean =>
  !!err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';

const mergeExternalNodes = async (
  id: string,
  inMemoryData: CanvasSaveData,
): Promise<CanvasSaveData> => {
  const known = knownNodeIds.get(id) ?? new Set<string>();

  let raw: string | null = null;
  try {
    raw = await fs.readFile(getFilePath(id), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      // Fresh canvas on disk — nothing to merge against; in-memory wins.
      return inMemoryData;
    }
    // Transient I/O failure. If the renderer is asking us to write an
    // empty canvas and we can't verify the disk is also empty, refuse
    // rather than risk clobbering real data.
    const memNodes = Array.isArray(inMemoryData.nodes) ? inMemoryData.nodes : [];
    if (memNodes.length === 0) {
      throw new Error(
        `[canvas-store] cannot verify on-disk canvas for ${id} before empty write: ${String(err)}`,
      );
    }
    return inMemoryData;
  }

  let diskNodes: CanvasNode[];
  try {
    const diskData = JSON.parse(raw) as CanvasSaveData;
    diskNodes = Array.isArray(diskData.nodes) ? diskData.nodes : [];
  } catch (err) {
    // Caught another writer mid-flush. If memory is empty, we have no
    // safe way to tell whether disk was empty too — refuse. Otherwise
    // fall back to the memory snapshot we were given (the save handler's
    // second-pass merge narrows this race further).
    const memNodes = Array.isArray(inMemoryData.nodes) ? inMemoryData.nodes : [];
    if (memNodes.length === 0) {
      throw new Error(
        `[canvas-store] canvas.json for ${id} was unparseable while guarding empty write: ${String(err)}`,
      );
    }
    return inMemoryData;
  }

  try {
    const memoryNodes = Array.isArray(inMemoryData.nodes) ? inMemoryData.nodes : [];

    const memoryNodesRaw = Array.isArray(inMemoryData.nodes) ? inMemoryData.nodes : [];

    // Hard safety: never let a save with an empty node list clobber a
    // non-empty on-disk canvas. This shields against early-lifecycle
    // flushSave calls that fire before the renderer has finished loading
    // (e.g. on window close / StrictMode double-invoke / HMR reload),
    // which would otherwise wipe the canvas because every disk id is
    // already in the `known` set.
    if (memoryNodesRaw.length === 0 && diskNodes.length > 0) {
      console.warn(
        `[canvas-store] refusing to overwrite ${diskNodes.length} on-disk nodes with empty memory for ${id}`,
      );
      return { ...inMemoryData, nodes: diskNodes };
    }

    const diskById = new Map<string, CanvasNode>();
    for (const n of diskNodes) {
      if (n.id) diskById.set(n.id, n);
    }

    // Rule 1: reconcile nodes that are in memory.
    //   - Both disk and memory have it → pick the newer `updatedAt`.
    //     A memory node without updatedAt is treated as "older than any
    //     timestamped disk version" — the common case where the CLI
    //     just wrote the disk copy with a timestamp.
    //   - Only memory has it:
    //       * id is in `known` → CLI deleted it between the renderer's
    //         last load and this save. Drop it so the save doesn't
    //         resurrect the deletion.
    //       * id is not in `known` → user just created it in memory
    //         and this is the first save that will persist it. Keep.
    const mergedExisting: CanvasNode[] = [];
    for (const memNode of memoryNodes) {
      if (!memNode.id) {
        mergedExisting.push(memNode);
        continue;
      }
      const diskNode = diskById.get(memNode.id);
      if (!diskNode) {
        if (known.has(memNode.id)) {
          // CLI-deleted; drop.
          continue;
        }
        mergedExisting.push(memNode);
        continue;
      }
      const memTs = typeof memNode.updatedAt === 'number' ? memNode.updatedAt : 0;
      const diskTs = typeof diskNode.updatedAt === 'number' ? diskNode.updatedAt : 0;
      mergedExisting.push(diskTs > memTs ? diskNode : memNode);
    }

    // Rule 2: nodes only on disk and never-seen → CLI creates, add them.
    const memoryIds = new Set(memoryNodes.map((n) => n.id).filter(Boolean) as string[]);
    const externalNewNodes = diskNodes.filter(
      (n) => n.id && !memoryIds.has(n.id) && !known.has(n.id),
    );

    // NOTE: we intentionally do NOT mutate `knownNodeIds` here. The save
    // handler calls `mergeExternalNodes` twice back-to-back (to narrow a
    // race with concurrent canvas-cli writes). If this function added
    // freshly-merged ids to `known` on the first call, the second call
    // would then see the in-memory new node's id as "known" but still
    // absent from disk — and Rule 1's "CLI deleted; drop" branch would
    // silently strip the node the user just created. The save handler
    // is responsible for updating `knownNodeIds` once, after writeFile.

    return {
      ...inMemoryData,
      nodes: [...mergedExisting, ...externalNewNodes],
    };
  } catch {
    return inMemoryData;
  }
};

/**
 * Per-workspace save lock. Serializes concurrent `canvas:save` invocations
 * for the same workspace so the read-merge-write sequence in each call
 * cannot interleave with itself. This does NOT protect against external
 * writers (canvas-cli); for that, `mergeExternalNodes` is called twice —
 * once up front and again immediately before `writeFile`.
 */
const saveLocks = new Map<string, Promise<unknown>>();

const withSaveLock = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
  const prev = saveLocks.get(id) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const tracked = next.finally(() => {
    if (saveLocks.get(id) === tracked) saveLocks.delete(id);
  });
  saveLocks.set(id, tracked);
  return next;
};

/**
 * File-system-based external-update bus.
 *
 * Previous designs used a Unix domain socket and later a loopback TCP
 * listener to let canvas-cli notify Electron of mutations. Both are
 * denied by the macOS Seatbelt profile that CLI agents like Codex wrap
 * their child processes in (`network-outbound` is limited to outgoing
 * DNS/HTTPS; AF_UNIX connect and AF_INET connect to 127.0.0.1 both
 * return EPERM). The only remaining channel the sandboxed CLI reliably
 * has is the filesystem, which it already uses to persist the canvas.
 *
 * So we invert the model: the CLI just writes `canvas.json`, and the
 * Electron main process watches that file. When its contents change
 * for any reason other than our own save handler having just written
 * the same content, we re-read it, diff against the last snapshot the
 * main process knew about, and broadcast the changed node IDs to every
 * renderer via the existing `canvas:external-update` IPC channel.
 *
 * Echo suppression: `canvas:save` updates `lastSnapshot` synchronously
 * after its own `writeFile`, so when the watcher fires (async, 100ms
 * debounced) for the renderer's own write, the disk content and the
 * snapshot are identical, the diff is empty, and nothing is broadcast.
 */
const watchers = new Map<string, FSWatcher>();
const watcherDebounce = new Map<string, NodeJS.Timeout>();
const lastSnapshot = new Map<string, Map<string, CanvasNode>>();

const nodesToMap = (nodes: CanvasNode[] | undefined): Map<string, CanvasNode> => {
  const m = new Map<string, CanvasNode>();
  if (!nodes) return m;
  for (const n of nodes) if (n.id) m.set(n.id, n);
  return m;
};

const diffSnapshots = (
  before: Map<string, CanvasNode>,
  after: Map<string, CanvasNode>,
): string[] => {
  const ids = new Set<string>();
  for (const [id, node] of after) {
    const prev = before.get(id);
    if (!prev) { ids.add(id); continue; }
    // Cheap timestamp check first, fall back to structural equality so
    // we also catch updates that forgot to bump updatedAt.
    if ((prev.updatedAt ?? 0) !== (node.updatedAt ?? 0)) {
      ids.add(id);
    } else if (JSON.stringify(prev) !== JSON.stringify(node)) {
      ids.add(id);
    }
  }
  for (const id of before.keys()) {
    if (!after.has(id)) ids.add(id);
  }
  return Array.from(ids);
};

const broadcastExternalUpdate = (workspaceId: string, nodeIds: string[]) => {
  const payload = {
    type: 'canvas:updated' as const,
    workspaceId,
    nodeIds,
    source: 'fs-watch' as const,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('canvas:external-update', payload);
  }
};

const handleWatcherFire = async (workspaceId: string): Promise<void> => {
  const filePath = getFilePath(workspaceId);
  let data: CanvasSaveData;
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    data = JSON.parse(raw);
  } catch {
    // Partial write or transient read failure — the next event will
    // catch the final state.
    return;
  }
  const newMap = nodesToMap(data.nodes);
  const oldMap = lastSnapshot.get(workspaceId) ?? new Map<string, CanvasNode>();
  const changedIds = diffSnapshots(oldMap, newMap);
  if (changedIds.length === 0) return;
  lastSnapshot.set(workspaceId, newMap);
  // Keep knownNodeIds aligned with disk so `mergeExternalNodes` Rule 2
  // (disk-only never-seen → append) doesn't re-add nodes that the
  // watcher has already observed.
  const known = knownNodeIds.get(workspaceId) ?? new Set<string>();
  for (const id of newMap.keys()) known.add(id);
  knownNodeIds.set(workspaceId, known);
  broadcastExternalUpdate(workspaceId, changedIds);
};

const startWorkspaceWatcher = (workspaceId: string): void => {
  if (watchers.has(workspaceId)) return;
  const filePath = getFilePath(workspaceId);
  let watcher: FSWatcher;
  try {
    watcher = fsWatch(filePath, { persistent: false });
  } catch (err) {
    console.warn(`[canvas-store] fs.watch failed for ${workspaceId}:`, err);
    return;
  }
  watcher.on('change', () => {
    const existing = watcherDebounce.get(workspaceId);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      watcherDebounce.delete(workspaceId);
      void handleWatcherFire(workspaceId);
    }, 100);
    watcherDebounce.set(workspaceId, t);
  });
  watcher.on('error', (err) => {
    console.warn(`[canvas-store] watcher error for ${workspaceId}:`, err);
  });
  watchers.set(workspaceId, watcher);
};

const stopWorkspaceWatcher = (workspaceId: string): void => {
  const w = watchers.get(workspaceId);
  if (w) {
    try { w.close(); } catch { /* ignore */ }
    watchers.delete(workspaceId);
  }
  const t = watcherDebounce.get(workspaceId);
  if (t) {
    clearTimeout(t);
    watcherDebounce.delete(workspaceId);
  }
  lastSnapshot.delete(workspaceId);
};

export const teardownCanvasWatchers = (): void => {
  for (const id of Array.from(watchers.keys())) stopWorkspaceWatcher(id);
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
          await withSaveLock(payload.id, async () => {
            // Snapshot what the renderer actually had in memory when it
            // sent this save. We compare against this after the merge
            // to detect CLI-side changes the renderer doesn't know yet
            // (see the broadcast below).
            const rendererMemoryMap = nodesToMap(
              (payload.data as CanvasSaveData).nodes,
            );
            // First merge against current disk state. This picks up any
            // CLI-added nodes (Rule 2) and resolves per-node conflicts
            // (Rule 1).
            const firstPass = await mergeExternalNodes(
              payload.id,
              payload.data as CanvasSaveData,
            );
            // Second merge, immediately before the write. Narrows the
            // window where a canvas-cli write could land between our
            // initial read and the writeFile below and be silently
            // clobbered. Using `firstPass` as input ensures any CLI
            // changes seen in the first read are preserved even if the
            // second read somehow fails to include them.
            const merged = await mergeExternalNodes(payload.id, firstPass);
            await fs.writeFile(
              getFilePath(payload.id),
              JSON.stringify(merged, null, 2),
              'utf-8'
            );
            // Update the watcher's last-known snapshot to match what we
            // just wrote. The debounced fs.watch callback will see an
            // empty diff and skip broadcasting, suppressing the echo of
            // our own write.
            const mergedMap = nodesToMap(merged.nodes);
            lastSnapshot.set(payload.id, mergedMap);
            // Now that the write has landed, mark every persisted id as
            // known so subsequent `mergeExternalNodes` calls can tell
            // "memory-only node the user just created" (not in known →
            // keep) from "CLI deleted a persisted node" (in known,
            // missing from disk → drop). Updating here rather than
            // inside `mergeExternalNodes` keeps the two back-to-back
            // merge calls within this save idempotent.
            const knownForWs = knownNodeIds.get(payload.id) ?? new Set<string>();
            if (Array.isArray(merged.nodes)) {
              for (const n of merged.nodes as CanvasNode[]) {
                if (n.id) knownForWs.add(n.id);
              }
            }
            knownNodeIds.set(payload.id, knownForWs);
            // If the merge result differs from the renderer's memory,
            // the CLI made changes between the renderer's last sync
            // and this save, and we just silently absorbed them into
            // the write. The fs.watch fire for this write will see
            // `lastSnapshot === disk` and skip broadcasting, so the
            // renderer would never hear about those changes (until a
            // manual reload). Push the diff back explicitly so its
            // in-memory state catches up.
            const pickedUp = diffSnapshots(rendererMemoryMap, mergedMap);
            if (pickedUp.length > 0) {
              broadcastExternalUpdate(payload.id, pickedUp);
            }
          });
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
          // Seed the known-id set the first time we load this workspace in
          // this app session. Do NOT re-seed on subsequent loads — the
          // external-update handler in the renderer calls `canvas:load` as
          // a peek after canvas-cli writes, and re-seeding here would race
          // with a concurrent `canvas:save`: the save's `mergeExternalNodes`
          // would then see the CLI-added id already in `known` and Rule 2
          // would drop it from the write. `mergeExternalNodes` itself keeps
          // `known` up to date whenever nodes are actually persisted.
          if (Array.isArray(data.nodes) && !knownNodeIds.has(payload.id)) {
            const known = new Set(
              data.nodes.map((n: CanvasNode) => n.id).filter((id): id is string => Boolean(id)),
            );
            knownNodeIds.set(payload.id, known);
          }
          // Seed / refresh the watcher's last-known snapshot and ensure
          // the fs.watch listener is running for this workspace. Starting
          // here (instead of at app launch) means we only watch workspaces
          // the user has actually opened, and guarantees the canvas.json
          // file already exists by the time we call fs.watch on it.
          lastSnapshot.set(payload.id, nodesToMap(data.nodes));
          startWorkspaceWatcher(payload.id);
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
        stopWorkspaceWatcher(payload.id);
        knownNodeIds.delete(payload.id);
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
