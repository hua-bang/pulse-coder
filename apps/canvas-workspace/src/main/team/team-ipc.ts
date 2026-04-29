/**
 * IPC for tearing down a team — wraps the multi-step disband flow that
 * the renderer can't safely orchestrate by itself:
 *   1. Find every team-member node inside the frame
 *   2. Kill any live PTYs they're attached to
 *   3. Remove those nodes from canvas.json
 *   4. Remove the team frame itself
 *   5. Archive the team's state directory via canvas-cli's destroyTeam
 *
 * Steps 1-4 must happen in the main process so we can release PTYs
 * before the canvas write removes the nodes that owned them. The
 * renderer just sends a single `team:disband` request and re-fetches
 * the canvas afterwards.
 */
import { BrowserWindow, ipcMain } from 'electron';
import { promises as fs } from 'fs';
import { join, dirname, basename } from 'path';
import { homedir } from 'os';
import { destroyTeam } from '@pulse-coder/canvas-cli/core';
import { hasSession, killSession } from '../pty-manager';

const STORE_DIR = join(homedir(), '.pulse-coder', 'canvas');

interface CanvasNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

interface CanvasSaveData {
  nodes: CanvasNode[];
  edges?: unknown[];
  transform?: unknown;
  savedAt: string;
}

function canvasPath(workspaceId: string): string {
  return join(STORE_DIR, workspaceId, 'canvas.json');
}

async function loadCanvas(workspaceId: string): Promise<CanvasSaveData | null> {
  try {
    const raw = await fs.readFile(canvasPath(workspaceId), 'utf-8');
    return JSON.parse(raw) as CanvasSaveData;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** Atomic-rename write mirrors what canvas-store.ts does — see its
 *  rationale comment. We can't import its private helper, so the
 *  duplication is the lesser evil compared to making it public. */
async function saveCanvas(workspaceId: string, data: CanvasSaveData): Promise<void> {
  data.savedAt = new Date().toISOString();
  const finalPath = canvasPath(workspaceId);
  const dir = dirname(finalPath);
  const base = basename(finalPath);
  const tmpPath = join(dir, `${base}.tmp`);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await fs.rename(tmpPath, finalPath);
}

function broadcastUpdate(workspaceId: string, nodeIds: string[]): void {
  const payload = {
    type: 'canvas:updated' as const,
    workspaceId,
    nodeIds,
    source: 'team-disband' as const,
  };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send('canvas:external-update', payload);
  }
}

interface DisbandRequest {
  workspaceId: string;
  /** Node id of the team's FrameNode (the one with `data.teamMeta`). */
  frameNodeId: string;
}

interface DisbandResult {
  ok: boolean;
  removedNodeIds?: string[];
  archivedTo?: string;
  error?: string;
}

export function setupTeamIpc(): void {
  ipcMain.handle('team:disband', async (_event, req: DisbandRequest): Promise<DisbandResult> => {
    try {
      const canvas = await loadCanvas(req.workspaceId);
      if (!canvas) return { ok: false, error: `Workspace not found: ${req.workspaceId}` };

      const frame = canvas.nodes.find((n) => n.id === req.frameNodeId);
      if (!frame) return { ok: false, error: `Frame node not found: ${req.frameNodeId}` };
      if (frame.type !== 'frame') {
        return { ok: false, error: `Node ${req.frameNodeId} is not a frame (got "${frame.type}")` };
      }
      const teamMeta = frame.data.teamMeta as { teamId: string } | undefined;
      if (!teamMeta) {
        return { ok: false, error: `Frame ${req.frameNodeId} is not a team frame (no teamMeta)` };
      }
      const teamId = teamMeta.teamId;

      // Find all member nodes belonging to this team. We match on
      // `teamMembership.teamId` (the durable link) rather than geometric
      // containment so that nodes the user has moved temporarily out of
      // the frame still get cleaned up.
      const memberNodeIds: string[] = [];
      for (const n of canvas.nodes) {
        if (n.type !== 'agent') continue;
        const tm = n.data.teamMembership as { teamId: string } | undefined;
        if (tm?.teamId === teamId) memberNodeIds.push(n.id);
      }

      // Kill any PTY sessions owned by the member nodes. We use
      // sessionId (the field actually wired into the PTY manager)
      // rather than nodeId because PTYs are sometimes spawned with a
      // distinct sessionId.
      for (const nodeId of memberNodeIds) {
        const node = canvas.nodes.find((n) => n.id === nodeId);
        const sessionId = (node?.data.sessionId as string | undefined) ?? '';
        if (sessionId && hasSession(sessionId)) {
          killSession(sessionId);
        }
      }

      // Remove the frame and member nodes from the canvas.
      const idsToRemove = new Set<string>([req.frameNodeId, ...memberNodeIds]);
      canvas.nodes = canvas.nodes.filter((n) => !idsToRemove.has(n.id));
      await saveCanvas(req.workspaceId, canvas);
      broadcastUpdate(req.workspaceId, Array.from(idsToRemove));

      // Archive the team's state directory. Done last so a failure here
      // doesn't leave the canvas with phantom nodes.
      const archive = await destroyTeam(teamId);

      return {
        ok: true,
        removedNodeIds: Array.from(idsToRemove),
        archivedTo: archive?.archivedTo,
      };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });
}
