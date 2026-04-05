/**
 * Canvas-update notifier — now a no-op stub.
 *
 * Previous versions opened a Unix domain socket, and later a loopback
 * TCP socket, to signal the Electron main process that canvas-cli had
 * mutated `canvas.json`. Both transports were denied by the macOS
 * Seatbelt profile that CLI agents like Codex wrap their subprocesses
 * in (`network-outbound` is limited to outgoing DNS/HTTPS; AF_UNIX
 * connect and AF_INET connect to 127.0.0.1 both return EPERM).
 *
 * Electron main now watches each workspace's `canvas.json` directly
 * via `fs.watch` (see `apps/canvas-workspace/src/main/canvas-store.ts`),
 * so the CLI only needs to persist the file — no IPC required. We
 * keep `notifyCanvasUpdated` as a resolving Promise for API stability
 * with existing callers in this package.
 */

export interface CanvasUpdateEvent {
  type: 'canvas:updated';
  workspaceId: string;
  /** IDs of nodes that were created/modified. Empty means "reload all". */
  nodeIds: string[];
  /** Mutation kind for optional UI affordances (highlight style, etc). */
  kind?: 'create' | 'update' | 'delete';
  source: 'cli';
}

export function notifyCanvasUpdated(
  _event: Omit<CanvasUpdateEvent, 'type' | 'source'>,
): Promise<void> {
  return Promise.resolve();
}
