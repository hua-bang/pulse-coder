import { promises as fs } from 'fs';
import { join } from 'path';
import { DEFAULT_STORE_DIR, AGENTS_MD_TEMPLATE } from './constants';
import type { CanvasNode, CanvasSaveData, WorkspaceManifest, Result } from './types';

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
  await fs.writeFile(manifestPath(storeDir), JSON.stringify(manifest, null, 2), 'utf-8');
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

export async function loadCanvas(workspaceId: string, storeDir?: string): Promise<CanvasSaveData | null> {
  try {
    const raw = await fs.readFile(canvasPath(workspaceId, storeDir), 'utf-8');
    const parsed = JSON.parse(raw) as CanvasSaveData;
    // Normalize: ensure nodes is always an array
    parsed.nodes = parsed.nodes ?? [];
    return parsed;
  } catch {
    return null;
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
    try {
      const raw = await fs.readFile(canvasPath(workspaceId, storeDir), 'utf-8');
      const existing = JSON.parse(raw) as CanvasSaveData;
      const existingNodes = Array.isArray(existing.nodes) ? existing.nodes : [];
      if (existingNodes.length > 0) {
        throw new CanvasWipeRefusedError(workspaceId, existingNodes.length);
      }
    } catch (err) {
      if (err instanceof CanvasWipeRefusedError) throw err;
      // File missing, unreadable, or unparseable — nothing on disk to
      // protect, fall through and write.
    }
  }

  await fs.writeFile(canvasPath(workspaceId, storeDir), JSON.stringify(data, null, 2), 'utf-8');
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
