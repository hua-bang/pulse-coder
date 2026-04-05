/**
 * Fire-and-forget notifier that tells a running canvas-workspace Electron
 * instance about canvas mutations made via canvas-cli.
 *
 * Transport is a localhost TCP listener on an OS-assigned port. The
 * Electron main process publishes the current port to a small file
 * under `$TMPDIR`. If that file is missing or stale (no listener on
 * the port), `notifyCanvasUpdated` silently no-ops — CLI mutations
 * still hit disk, and any running Electron instance that opens the
 * workspace later will load from disk.
 *
 * Why TCP and not a Unix domain socket: sandboxed child processes
 * launched by CLI agents (e.g. Codex under macOS Seatbelt) run with
 * `network-outbound` limited to `(remote tcp)` / `(remote udp)`.
 * Unix socket `connect()` is rejected with `EPERM` regardless of
 * the socket path, so we use a plain TCP loopback connection which
 * the sandbox permits.
 *
 * Protocol: single line of JSON, then close:
 *   {"type":"canvas:updated","workspaceId":"...","nodeIds":["..."],"source":"cli"}
 */
import net from 'net';
import { appendFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

export interface CanvasUpdateEvent {
  type: 'canvas:updated';
  workspaceId: string;
  /** IDs of nodes that were created/modified. Empty means "reload all". */
  nodeIds: string[];
  /** Mutation kind for optional UI affordances (highlight style, etc). */
  kind?: 'create' | 'update' | 'delete';
  source: 'cli';
}

/**
 * Path to the port-discovery file published by the Electron main process.
 * Must stay in sync with the server in
 * `apps/canvas-workspace/src/main/canvas-ipc-server.ts`.
 */
export function getIpcPortFilePath(): string {
  return join(tmpdir(), 'pulse-coder-canvas-ipc.port');
}

const DEBUG_LOG_PATH = join(tmpdir(), 'pulse-coder-canvas-cli-notifier.log');

const debugLog = (msg: string): void => {
  try {
    const ts = new Date().toISOString();
    const pid = process.pid;
    const ppid = process.ppid;
    appendFileSync(DEBUG_LOG_PATH, `[${ts}] pid=${pid} ppid=${ppid} ${msg}\n`);
  } catch {
    // ignore — logging must never crash the CLI
  }
};

const readPort = (): number | null => {
  try {
    const raw = readFileSync(getIpcPortFilePath(), 'utf-8').trim();
    const port = Number.parseInt(raw, 10);
    if (!Number.isFinite(port) || port <= 0 || port > 65535) return null;
    return port;
  } catch {
    return null;
  }
};

/**
 * Send an update event to the Electron main process. Never throws; any
 * connection error is swallowed (Electron may simply not be running).
 * Resolves once the line has been written, or immediately on error.
 */
export function notifyCanvasUpdated(event: Omit<CanvasUpdateEvent, 'type' | 'source'>): Promise<void> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const port = readPort();
    debugLog(`notify start workspaceId=${event.workspaceId} nodeIds=${JSON.stringify(event.nodeIds)} kind=${event.kind ?? ''} port=${port ?? 'missing'}`);

    let settled = false;
    const done = (reason: string) => {
      if (settled) return;
      settled = true;
      debugLog(`notify done reason=${reason} elapsed=${Date.now() - startedAt}ms`);
      resolve();
    };

    if (port === null) {
      done('no-port-file');
      return;
    }

    let socket: net.Socket;
    try {
      socket = net.createConnection({ host: '127.0.0.1', port });
    } catch (err) {
      debugLog(`notify createConnection threw: ${String(err)}`);
      done('createConnection-threw');
      return;
    }

    // Generous timeout: when the Electron main process is busy serving
    // canvas:save traffic from the renderer (e.g. the scrollback autosave
    // interval firing while an agent produces output), the server's
    // `accept()` may be delayed well beyond the ~1ms a loopback TCP
    // connect usually takes. 2s is still short enough to not noticeably
    // stall CLI commands if Electron isn't running.
    socket.setTimeout(2000);

    socket.once('connect', () => {
      debugLog(`notify socket connected elapsed=${Date.now() - startedAt}ms`);
      const payload: CanvasUpdateEvent = {
        type: 'canvas:updated',
        source: 'cli',
        workspaceId: event.workspaceId,
        nodeIds: event.nodeIds,
        kind: event.kind,
      };
      const line = JSON.stringify(payload) + '\n';
      socket.end(line, () => {
        debugLog(`notify socket end-callback fired (bytes written=${line.length})`);
      });
    });

    socket.once('error', (err) => {
      debugLog(`notify socket error: code=${(err as NodeJS.ErrnoException).code ?? ''} msg=${err.message}`);
      done('error');
    });
    socket.once('timeout', () => {
      debugLog(`notify socket timeout fired`);
      socket.destroy();
      done('timeout');
    });
    socket.once('close', (hadError) => {
      debugLog(`notify socket close hadError=${hadError}`);
      done('close');
    });
  });
}
