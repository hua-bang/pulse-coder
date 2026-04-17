import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
import { DEFAULT_STORE_DIR, AGENTS_MD_TEMPLATE } from './constants';
import type { CanvasNode, CanvasEdge, CanvasSaveData, WorkspaceManifest, Result } from './types';

function resolveDir(storeDir?: string): string {
  return storeDir ?? DEFAULT_STORE_DIR;
}

function manifestPath(storeDir?: string): string {
  return join(resolveDir(storeDir), '__workspaces__.json');
}

function canvasPath(workspaceId: string, storeDir?: string): string {
  return join(resolveDir(storeDir), workspaceId, 'canvas.json');
}

export function getWorkspaceDir(workspaceId: string, storeDir?: string): string {
  return join(resolveDir(storeDir), workspaceId);
}

/**
 * Atomically write canvas JSON with a rolling `.bak` backup.
 *
 * `fs.writeFile` is non-atomic — it truncates first, then streams bytes.
 * A crash or a concurrent reader hitting that window leaves the file
 * empty/partial, producing "Unexpected end of JSON input" on next load.
 * With multiple writers racing on the same file (canvas-workspace,
 * canvas-cli, canvas-agent, MCP server), the truncate window is wide
 * enough to corrupt data in practice. This helper:
 *   1. Writes the new content to `<path>.tmp`.
 *   2. Copies the current `<path>` to `<path>.bak` iff it parses and has
 *      at least one node (rolling last-known-good snapshot).
 *   3. Renames `<path>.tmp` → `<path>`. Rename is atomic on the same
 *      filesystem, so concurrent readers see either the old or the new
 *      file — never a truncated one.
 *
 * The matching `loadCanvas` below falls back to `<path>.bak` if the
 * primary file can't be read, giving self-healing recovery from any
 * pre-existing corruption left by older non-atomic writes.
 */
export async function atomicWriteCanvasJson(
  finalPath: string,
  serialized: string,
): Promise<void> {
  const dir = dirname(finalPath);
  const base = basename(finalPath);
  const tmpPath = join(dir, `${base}.tmp`);
  const bakPath = join(dir, `${base}.bak`);

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, serialized, 'utf-8');

  // Rotate last-known-good into .bak BEFORE overwriting, but only if
  // the current file is actually a good snapshot. Otherwise a single
  // corrupt save would poison the backup.
  try {
    const currentRaw = await fs.readFile(finalPath, 'utf-8');
    try {
      const current = JSON.parse(currentRaw) as { nodes?: unknown[] };
      if (Array.isArray(current.nodes) && current.nodes.length > 0) {
        await fs.copyFile(finalPath, bakPath).catch(() => undefined);
      }
    } catch {
      // Current file is already corrupt — leave the existing .bak alone.
    }
  } catch {
    // No current file yet; nothing to back up.
  }

  await fs.rename(tmpPath, finalPath);
}

export async function loadWorkspaceManifest(storeDir?: string): Promise<WorkspaceManifest> {
  try {
    const raw = await fs.readFile(manifestPath(storeDir), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    // Support both Electron format ("workspaces") and legacy CLI format ("entries")
    const workspaces = (parsed.workspaces ?? parsed.entries ?? []) as WorkspaceManifest['workspaces'];
    return { workspaces, activeId: parsed.activeId as string | undefined };
  } catch {
    return { workspaces: [] };
  }
}

export async function saveWorkspaceManifest(manifest: WorkspaceManifest, storeDir?: string): Promise<void> {
  const dir = resolveDir(storeDir);
  await fs.mkdir(dir, { recursive: true });
  await atomicWriteCanvasJson(manifestPath(storeDir), JSON.stringify(manifest, null, 2));
}

export async function listWorkspaceIds(storeDir?: string): Promise<string[]> {
  const dir = resolveDir(storeDir);
  try {
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return entries
      .filter(e => e.isDirectory() && e.name !== '__workspaces__')
      .map(e => e.name);
  } catch {
    return [];
  }
}

export async function ensureWorkspaceDir(workspaceId: string, storeDir?: string): Promise<void> {
  const dir = getWorkspaceDir(workspaceId, storeDir);
  await fs.mkdir(dir, { recursive: true });
  const agentsPath = join(dir, 'AGENTS.md');
  const exists = await fs.access(agentsPath).then(() => true).catch(() => false);
  if (!exists) {
    await fs.writeFile(agentsPath, AGENTS_MD_TEMPLATE, 'utf-8');
  }
}

/**
 * Thrown by `loadCanvas` when the canvas file exists on disk but is
 * unreadable — typically because another writer caught it mid-flush and
 * `JSON.parse` failed, or because of an I/O error.
 *
 * This is deliberately distinct from the null-return-on-ENOENT case so
 * callers can tell "the canvas really doesn't exist" (safe to bootstrap)
 * apart from "we couldn't read the canvas right now" (DO NOT bootstrap —
 * that would silently wipe real user data).
 */
export class CanvasReadError extends Error {
  readonly workspaceId: string;
  readonly cause: unknown;
  constructor(workspaceId: string, cause: unknown) {
    super(
      `[canvas-cli] failed to read canvas.json for workspace "${workspaceId}": ` +
      `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = 'CanvasReadError';
    this.workspaceId = workspaceId;
    this.cause = cause;
  }
}

function isEnoent(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'ENOENT';
}

export async function loadCanvas(workspaceId: string, storeDir?: string): Promise<CanvasSaveData | null> {
  const primary = canvasPath(workspaceId, storeDir);
  const backup = `${primary}.bak`;

  let primaryErr: unknown = null;
  let raw: string | null = null;
  try {
    raw = await fs.readFile(primary, 'utf-8');
  } catch (err) {
    if (isEnoent(err)) {
      // Primary genuinely absent — fall through to the backup check so a
      // corruption that deleted the primary can still self-heal.
      raw = null;
    } else {
      primaryErr = err;
    }
  }

  if (raw !== null) {
    try {
      const parsed = JSON.parse(raw) as CanvasSaveData;
      parsed.nodes = parsed.nodes ?? [];
      return parsed;
    } catch (err) {
      primaryErr = err;
      raw = null;
    }
  }

  // Primary unreadable or unparseable: try the rolling .bak snapshot so
  // one bad write doesn't permanently destroy the workspace's nodes.
  try {
    const bakRaw = await fs.readFile(backup, 'utf-8');
    const parsed = JSON.parse(bakRaw) as CanvasSaveData;
    parsed.nodes = parsed.nodes ?? [];
    if (primaryErr) {
      console.warn(
        `[canvas-cli] canvas.json for "${workspaceId}" unreadable (${String(primaryErr)}); recovered from canvas.json.bak`,
      );
    }
    return parsed;
  } catch (bakErr) {
    if (isEnoent(bakErr) && !primaryErr) {
      // Neither file exists — legitimate "no canvas yet".
      return null;
    }
    // Primary failed AND backup is missing/bad, OR primary missing and
    // backup corrupt. Surface the primary's failure so callers don't
    // confuse it with "no canvas" and bootstrap an empty one on top.
    throw new CanvasReadError(workspaceId, primaryErr ?? bakErr);
  }
}

export interface SaveCanvasOptions {
  /**
   * Allow the save to proceed even when `data.nodes` is empty and the on-disk
   * canvas currently has nodes. Default `false`: the save throws to protect
   * against accidental wipes (buggy caller flushing uninitialized state,
   * partially-loaded in-memory snapshot, etc).
   *
   * Set to `true` for flows that legitimately may end up with an empty
   * canvas, e.g. initializing a brand-new workspace or an explicit per-node
   * deletion that happens to remove the last node.
   */
  allowEmpty?: boolean;
}

/**
 * Thrown by `saveCanvas` when the incoming data has an empty `nodes` array
 * but the on-disk canvas currently has nodes, and the caller did not pass
 * `{ allowEmpty: true }`.
 */
export class CanvasWipeRefusedError extends Error {
  readonly workspaceId: string;
  readonly existingNodeCount: number;
  constructor(workspaceId: string, existingNodeCount: number) {
    super(
      `[canvas-cli] refusing to overwrite ${existingNodeCount} on-disk nodes ` +
      `with empty nodes for workspace "${workspaceId}". ` +
      `Pass { allowEmpty: true } to saveCanvas if this wipe is intentional.`,
    );
    this.name = 'CanvasWipeRefusedError';
    this.workspaceId = workspaceId;
    this.existingNodeCount = existingNodeCount;
  }
}

export async function saveCanvas(
  workspaceId: string,
  data: CanvasSaveData,
  storeDir?: string,
  opts: SaveCanvasOptions = {},
): Promise<void> {
  await ensureWorkspaceDir(workspaceId, storeDir);

  // Safety: don't silently overwrite a non-empty canvas with empty nodes.
  // This mirrors the Electron main-process guard in
  // `apps/canvas-workspace/src/main/canvas-store.ts` so every write path
  // into `canvas.json` has the same protection.
  if (!opts.allowEmpty && Array.isArray(data.nodes) && data.nodes.length === 0) {
    let raw: string | null = null;
    try {
      raw = await fs.readFile(canvasPath(workspaceId, storeDir), 'utf-8');
    } catch (err) {
      if (!isEnoent(err)) {
        // Can't verify what's on disk — refuse rather than risk wiping
        // a populated canvas we just happened to fail to read.
        throw new CanvasReadError(workspaceId, err);
      }
      // ENOENT → nothing on disk, fall through and write.
    }
    if (raw !== null) {
      let existingNodes: CanvasNode[];
      try {
        const existing = JSON.parse(raw) as CanvasSaveData;
        existingNodes = Array.isArray(existing.nodes) ? existing.nodes : [];
      } catch (err) {
        // Parse failure mid-flight: if we assume "nothing to protect" and
        // write `{nodes: []}` we'd be committing the exact data-loss bug
        // this guard exists to prevent. Refuse.
        throw new CanvasReadError(workspaceId, err);
      }
      if (existingNodes.length > 0) {
        throw new CanvasWipeRefusedError(workspaceId, existingNodes.length);
      }
    }
  }

  await atomicWriteCanvasJson(canvasPath(workspaceId, storeDir), JSON.stringify(data, null, 2));
}

/**
 * Describes a single-node mutation to apply atomically against the latest
 * on-disk canvas. Exactly one of the fields should be set:
 *  - upsert: insert or replace the given node (matched by id)
 *  - removeId: remove the node with this id
 */
export interface NodeMutation {
  upsert?: CanvasNode;
  removeId?: string;
}

/**
 * Apply a single-node mutation by re-reading canvas.json immediately before
 * writing it back. This shrinks the race window with other writers
 * (Electron renderer autosave, other canvas-cli invocations) from the
 * duration of the calling function down to the time between this read and
 * the subsequent `writeFile` — typically microseconds.
 *
 * The caller is responsible for having already performed any side effects
 * (e.g. writing the backing note file on disk) before calling this.
 */
export async function commitNodeMutation(
  workspaceId: string,
  mutation: NodeMutation,
  storeDir?: string,
): Promise<CanvasSaveData | null> {
  const fresh = (await loadCanvas(workspaceId, storeDir)) ?? {
    nodes: [],
    transform: { x: 0, y: 0, scale: 1 },
    savedAt: new Date().toISOString(),
  };

  if (mutation.upsert) {
    const target = mutation.upsert;
    const idx = fresh.nodes.findIndex(n => n.id === target.id);
    if (idx >= 0) fresh.nodes[idx] = target;
    else fresh.nodes.push(target);
  }
  if (mutation.removeId) {
    const idx = fresh.nodes.findIndex(n => n.id === mutation.removeId);
    if (idx === -1) return null;
    fresh.nodes.splice(idx, 1);
  }

  fresh.savedAt = new Date().toISOString();
  // `removeId` can legitimately reduce the canvas to 0 nodes when the user
  // deletes the last one; opt in so the wipe guard doesn't reject that.
  await saveCanvas(workspaceId, fresh, storeDir, { allowEmpty: true });
  return fresh;
}

/**
 * Describes a single-edge mutation to apply atomically against the latest
 * on-disk canvas. Exactly one of the fields should be set:
 *  - upsert: insert or replace the given edge (matched by id)
 *  - removeId: remove the edge with this id
 */
export interface EdgeMutation {
  upsert?: CanvasEdge;
  removeId?: string;
}

/**
 * Apply a single-edge mutation by re-reading canvas.json immediately before
 * writing it back. Mirrors `commitNodeMutation` but operates on the `edges`
 * array. The caller is responsible for validating endpoints (e.g. node ids
 * exist) before calling this.
 */
export async function commitEdgeMutation(
  workspaceId: string,
  mutation: EdgeMutation,
  storeDir?: string,
): Promise<CanvasSaveData | null> {
  const fresh = (await loadCanvas(workspaceId, storeDir)) ?? {
    nodes: [],
    edges: [],
    transform: { x: 0, y: 0, scale: 1 },
    savedAt: new Date().toISOString(),
  };

  const edges = fresh.edges ?? [];

  if (mutation.upsert) {
    const target = mutation.upsert;
    const idx = edges.findIndex(e => e.id === target.id);
    if (idx >= 0) edges[idx] = target;
    else edges.push(target);
  }
  if (mutation.removeId) {
    const idx = edges.findIndex(e => e.id === mutation.removeId);
    if (idx === -1) return null;
    edges.splice(idx, 1);
  }

  fresh.edges = edges;
  fresh.savedAt = new Date().toISOString();
  await saveCanvas(workspaceId, fresh, storeDir, { allowEmpty: true });
  return fresh;
}

export async function createWorkspace(
  name: string,
  storeDir?: string,
): Promise<Result<{ id: string }>> {
  try {
    const id = `ws-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await ensureWorkspaceDir(id, storeDir);

    // Initialize empty canvas
    const emptyCanvas: CanvasSaveData = {
      nodes: [],
      transform: { x: 0, y: 0, scale: 1 },
      savedAt: new Date().toISOString(),
    };
    // Brand-new workspace: the canvas file shouldn't exist yet, but opt in
    // explicitly so the wipe guard is never tripped by this bootstrap step.
    await saveCanvas(id, emptyCanvas, storeDir, { allowEmpty: true });

    // Update manifest
    const manifest = await loadWorkspaceManifest(storeDir);
    manifest.workspaces.push({ id, name });
    await saveWorkspaceManifest(manifest, storeDir);

    return { ok: true, data: { id } };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function deleteWorkspace(
  workspaceId: string,
  storeDir?: string,
): Promise<Result> {
  try {
    const dir = getWorkspaceDir(workspaceId, storeDir);
    await fs.rm(dir, { recursive: true, force: true });

    // Update manifest
    const manifest = await loadWorkspaceManifest(storeDir);
    manifest.workspaces = manifest.workspaces.filter(e => e.id !== workspaceId);
    await saveWorkspaceManifest(manifest, storeDir);

    return { ok: true, data: undefined };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
