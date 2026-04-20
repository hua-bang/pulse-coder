import { ipcMain, BrowserWindow } from "electron";
import { promises as fs, watch as fsWatch, FSWatcher } from "fs";
import { join, basename, dirname } from "path";
import { homedir } from "os";

const STORE_DIR = join(homedir(), ".pulse-coder", "canvas");
const MANIFEST_ID = '__workspaces__';

/**
 * Atomically write canvas JSON to disk with a rolling backup.
 *
 * Node's `fs.writeFile` is NOT atomic — it truncates first, then streams
 * the bytes. If the process crashes mid-write, or if another reader
 * catches the truncate window, the file is left empty/partial and future
 * loads fail with `Unexpected end of JSON input`. With multiple writers
 * (canvas-workspace + canvas-cli + canvas-agent + MCP server) racing on
 * the same file, this is a real data-loss path.
 *
 * This helper:
 *   1. Writes the new content to `<path>.tmp`.
 *   2. If the current `<path>` parses and contains at least one node,
 *      copies it to `<path>.bak` (rolling last-known-good snapshot).
 *   3. `rename()`s `<path>.tmp` → `<path>`. Rename is atomic on the same
 *      filesystem: any concurrent reader sees either the old file or the
 *      new one, never a truncated one.
 *
 * Recovery: `canvas:load` falls back to `<path>.bak` when the primary
 * file fails to parse, so even a pre-existing corruption from an older
 * non-atomic write path can self-heal on next load.
 */
const atomicWriteCanvasJson = async (
  finalPath: string,
  serialized: string,
): Promise<void> => {
  const dir = dirname(finalPath);
  const base = basename(finalPath);
  const tmpPath = join(dir, `${base}.tmp`);
  const bakPath = join(dir, `${base}.bak`);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, serialized, 'utf-8');

  // Rotate last-known-good into .bak BEFORE overwriting. Only rotate if
  // the current file is actually a good snapshot — parses and has at
  // least one node. That prevents a single corrupt save from poisoning
  // the backup.
  try {
    const currentRaw = await fs.readFile(finalPath, 'utf-8');
    try {
      const current = JSON.parse(currentRaw) as { nodes?: unknown[] };
      if (Array.isArray(current.nodes) && current.nodes.length > 0) {
        await fs.copyFile(finalPath, bakPath).catch(() => undefined);
      }
    } catch {
      // Current file is already corrupt — don't overwrite the good .bak.
    }
  } catch {
    // No current file yet (first write for this workspace) — nothing to back up.
  }

  await fs.rename(tmpPath, finalPath);
};

/**
 * Read canvas JSON with transparent fallback to the rolling `.bak` if
 * the primary file is missing or unparseable. Returns the parsed data
 * plus a `recoveredFromBackup` flag so callers can log / re-persist.
 */
const readCanvasJsonWithRecovery = async (
  finalPath: string,
): Promise<
  | { kind: 'ok'; data: unknown; recoveredFromBackup: boolean }
  | { kind: 'missing' }
  | { kind: 'unrecoverable'; err: unknown }
> => {
  const bakPath = `${finalPath}.bak`;
  let primaryErr: unknown = null;
  try {
    const raw = await fs.readFile(finalPath, 'utf-8');
    try {
      const data = JSON.parse(raw);
      return { kind: 'ok', data, recoveredFromBackup: false };
    } catch (err) {
      primaryErr = err;
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
      // Primary file missing. Try backup; if that's also missing,
      // treat the whole workspace as fresh.
    } else {
      primaryErr = err;
    }
  }

  try {
    const bakRaw = await fs.readFile(bakPath, 'utf-8');
    const data = JSON.parse(bakRaw);
    console.warn(
      `[canvas-store] primary canvas.json unreadable (${String(primaryErr ?? 'missing')}); recovered from ${basename(bakPath)}`,
    );
    return { kind: 'ok', data, recoveredFromBackup: true };
  } catch (bakErr) {
    if ((bakErr as NodeJS.ErrnoException)?.code === 'ENOENT') {
      return primaryErr ? { kind: 'unrecoverable', err: primaryErr } : { kind: 'missing' };
    }
    return { kind: 'unrecoverable', err: primaryErr ?? bakErr };
  }
};

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
  let raw: string;
  try {
    raw = await fs.readFile(oldPath, 'utf-8');
  } catch {
    // no old file either — fresh workspace, nothing to migrate
    return;
  }
  // Validate the legacy file parses before propagating it. A non-atomic
  // copy of unparseable bytes would just move the corruption into the
  // new canonical path, where loaders would then trip on it forever.
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.warn(
      `[canvas-store] refusing to migrate unparseable legacy canvas for ${id} ` +
      `at ${oldPath}: ${err instanceof Error ? err.message : String(err)}. ` +
      `Leaving the legacy file in place.`,
    );
    return;
  }
  await fs.mkdir(getWorkspaceDir(id), { recursive: true });
  // Use the same atomic helper as every other writer so a crash mid-
  // migration cannot leave a partial canvas.json at the new path.
  await atomicWriteCanvasJson(newPath, JSON.stringify(parsed, null, 2));
  await fs.unlink(oldPath).catch(() => undefined);
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

/**
 * Sentinel returned by `mergeExternalNodes` when we can't verify the
 * on-disk canvas AND the renderer is asking us to write an empty one.
 * The save handler treats this as a silent skip instead of a failed save
 * so the tried-and-true "refuse to clobber" guard doesn't surface as an
 * unhandledRejection when the outer lock chain hasn't attached a catch yet.
 */
const SKIP_WRITE = Symbol('canvas-store:skip-write');
type MergeResult = CanvasSaveData | typeof SKIP_WRITE;

type DiskReadOutcome =
  | { kind: 'ok'; nodes: CanvasNode[]; recoveredFromBackup?: boolean }
  | { kind: 'missing' }
  | { kind: 'unparseable'; err: unknown }
  | { kind: 'ioerror'; err: unknown };

/**
 * Read and parse the workspace's canvas.json, retrying a few times when
 * the read lands on an in-progress write from canvas-cli or another
 * writer. A truncated/half-written file surfaces as a JSON.parse error
 * (typically "Unexpected end of JSON input"); a brief backoff almost
 * always catches the completed write on the next attempt.
 *
 * If every retry still fails to parse, fall back to the rolling `.bak`
 * snapshot that `atomicWriteCanvasJson` maintains. This matches the
 * recovery path in `canvas:load` (`readCanvasJsonWithRecovery`) so the
 * save handler no longer indefinitely skips writes on a workspace whose
 * primary file was corrupted by a pre-atomic-writes-era crash. When the
 * backup rescues us, the caller's subsequent `atomicWriteCanvasJson`
 * will naturally heal the primary as part of the same save.
 */
const readDiskCanvas = async (
  id: string,
  attempts = 3,
  delayMs = 30,
): Promise<DiskReadOutcome> => {
  const primaryPath = getFilePath(id);
  let lastParseErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    let raw: string;
    try {
      raw = await fs.readFile(primaryPath, 'utf-8');
    } catch (err) {
      if (isEnoent(err)) return { kind: 'missing' };
      return { kind: 'ioerror', err };
    }
    try {
      const diskData = JSON.parse(raw) as CanvasSaveData;
      const nodes = Array.isArray(diskData.nodes) ? diskData.nodes : [];
      return { kind: 'ok', nodes };
    } catch (err) {
      lastParseErr = err;
      if (i < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  // Primary unparseable after retries. Try the rolling backup — a
  // genuinely concurrent mid-flush would have been caught by one of the
  // retries above, so persistent parse errors almost always mean the
  // primary is stuck in a corrupt state from an older non-atomic write.
  try {
    const bakRaw = await fs.readFile(`${primaryPath}.bak`, 'utf-8');
    const bakData = JSON.parse(bakRaw) as CanvasSaveData;
    const nodes = Array.isArray(bakData.nodes) ? bakData.nodes : [];
    console.warn(
      `[canvas-store] canvas.json for ${id} unparseable (${String(lastParseErr)}); ` +
      `recovered ${nodes.length} nodes from canvas.json.bak`,
    );
    return { kind: 'ok', nodes, recoveredFromBackup: true };
  } catch {
    // Backup missing or also bad — surface the original parse failure.
    return { kind: 'unparseable', err: lastParseErr };
  }
};

const mergeExternalNodes = async (
  id: string,
  inMemoryData: CanvasSaveData,
): Promise<MergeResult> => {
  const known = knownNodeIds.get(id) ?? new Set<string>();
  const memoryNodes = Array.isArray(inMemoryData.nodes) ? inMemoryData.nodes : [];

  const disk = await readDiskCanvas(id);

  if (disk.kind === 'missing') {
    // Fresh canvas on disk — nothing to merge against; in-memory wins.
    return inMemoryData;
  }

  if (disk.kind === 'ioerror' || disk.kind === 'unparseable') {
    // Transient read failure or caught another writer mid-flush (even
    // after retries). If memory is empty, we can't verify the disk is
    // also empty — skip the write rather than risk clobbering real data.
    // Memory-has-data case falls back to the memory snapshot; the save
    // handler's second-pass merge narrows the race further.
    if (memoryNodes.length === 0) {
      const reason =
        disk.kind === 'unparseable'
          ? 'canvas.json was unparseable (likely mid-flush)'
          : 'canvas.json read failed';
      console.warn(
        `[canvas-store] skipping empty write for ${id}: ${reason} — ${String(disk.err)}`,
      );
      return SKIP_WRITE;
    }
    return inMemoryData;
  }

  const diskNodes = disk.nodes;

  // Hard safety: never let a save with an empty node list clobber a
  // non-empty on-disk canvas. This shields against early-lifecycle
  // flushSave calls that fire before the renderer has finished loading
  // (e.g. on window close / StrictMode double-invoke / HMR reload),
  // which would otherwise wipe the canvas because every disk id is
  // already in the `known` set.
  if (memoryNodes.length === 0 && diskNodes.length > 0) {
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

  // Rule 3 (partial-memory safety net): if the renderer's memory snapshot
  // is suspiciously smaller than what we've already persisted, refuse to
  // drop the missing-from-memory disk nodes. This catches the wipe path
  // where Rule 1 treats every disk-known-but-memory-absent id as a
  // "user delete" — legitimate when memory is a complete snapshot, but
  // catastrophic when memory is a partial/half-loaded snapshot (React
  // StrictMode double-mount, HMR, beforeunload fired mid-load, an
  // unmount during a state update, etc).
  //
  // Heuristic: only trigger when a lot of known nodes went missing AND
  // memory is much smaller than disk. This stays conservative so ordinary
  // "user deleted a couple of nodes" saves still propagate the deletion.
  const missingKnownDiskNodes = diskNodes.filter(
    (n) => !!n.id && known.has(n.id) && !memoryIds.has(n.id),
  );
  const knownDiskCount = diskNodes.reduce(
    (count, n) => (n.id && known.has(n.id) ? count + 1 : count),
    0,
  );
  const suspiciousShrink =
    missingKnownDiskNodes.length >= 5 &&
    knownDiskCount > 0 &&
    missingKnownDiskNodes.length / knownDiskCount >= 0.5 &&
    memoryNodes.length < missingKnownDiskNodes.length;

  let preservedMissing: CanvasNode[] = [];
  if (suspiciousShrink) {
    console.warn(
      `[canvas-store] suspicious shrink for ${id}: memory has ${memoryNodes.length} nodes ` +
      `but ${missingKnownDiskNodes.length}/${knownDiskCount} previously-persisted disk nodes are absent. ` +
      `Preserving them in case this is a partial snapshot (load race / HMR / double-mount).`,
    );
    preservedMissing = missingKnownDiskNodes;
  }

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
    nodes: [...mergedExisting, ...externalNewNodes, ...preservedMissing],
  };
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
  // The chain promise stored in `saveLocks` only exists to sequence the
  // NEXT save via `prev.then(fn, fn)`. If `fn` rejects and no subsequent
  // save arrives before the microtask queue checks, `tracked` would
  // surface as an unhandledRejection. The caller still sees the real
  // error via `next`; swallow it here.
  tracked.catch(() => undefined);
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
          await atomicWriteCanvasJson(
            getFilePath(MANIFEST_ID),
            JSON.stringify(payload.data, null, 2),
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
            if (firstPass === SKIP_WRITE) return;
            // Second merge, immediately before the write. Narrows the
            // window where a canvas-cli write could land between our
            // initial read and the writeFile below and be silently
            // clobbered. Using `firstPass` as input ensures any CLI
            // changes seen in the first read are preserved even if the
            // second read somehow fails to include them.
            const merged = await mergeExternalNodes(payload.id, firstPass);
            if (merged === SKIP_WRITE) return;
            await atomicWriteCanvasJson(
              getFilePath(payload.id),
              JSON.stringify(merged, null, 2),
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
        const readResult = await readCanvasJsonWithRecovery(filePath);
        if (readResult.kind === 'missing') {
          return { ok: true, data: null };
        }
        if (readResult.kind === 'unrecoverable') {
          return { ok: false, error: String(readResult.err) };
        }
        const data: CanvasSaveData = readResult.data as CanvasSaveData;
        if (payload.id !== MANIFEST_ID) {
          const dirty = await migrateNotePaths(payload.id, data);
          // Re-persist if migration rewrote note paths OR if we recovered
          // from the rolling backup (the primary file was corrupt; writing
          // the recovered data back heals it).
          if (dirty || readResult.recoveredFromBackup) {
            await atomicWriteCanvasJson(filePath, JSON.stringify(data, null, 2));
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
