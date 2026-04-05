/**
 * Fire-and-forget notifier that tells a running canvas-workspace Electron
 * instance about canvas mutations made via canvas-cli.
 *
 * The Electron main process listens on a local socket (Unix domain socket
 * on POSIX, named pipe on Windows). If no instance is running, the notify
 * call silently no-ops — CLI mutations still hit disk, and any running
 * Electron instance that opens the workspace later will load from disk.
 *
 * Protocol: single line of JSON, then close:
 *   {"type":"canvas:updated","workspaceId":"...","nodeIds":["..."],"source":"cli"}
 */
import net from 'net';
import { appendFileSync } from 'fs';
import { join } from 'path';
import { platform, tmpdir } from 'os';

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
 * Socket lives under the OS temp dir rather than `$HOME/.pulse-coder` so
 * that sandboxed child processes (e.g. commands launched by Codex/Claude
 * CLI under macOS Seatbelt) can still reach it — the default Seatbelt
 * profile denies writes and unix-socket connects under `$HOME` but
 * permits them under `$TMPDIR`.
 */
export function getIpcSocketPath(): string {
  if (platform() === 'win32') {
    return '\\\\.\\pipe\\pulse-coder-canvas-ipc';
  }
  return join(tmpdir(), 'pulse-coder-canvas-ipc.sock');
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

/**
 * Send an update event to the Electron main process. Never throws; any
 * connection error is swallowed (Electron may simply not be running).
 * Resolves once the line has been written, or immediately on error.
 */
export function notifyCanvasUpdated(event: Omit<CanvasUpdateEvent, 'type' | 'source'>): Promise<void> {
  return new Promise((resolve) => {
    const sockPath = getIpcSocketPath();
    const startedAt = Date.now();
    debugLog(`notify start workspaceId=${event.workspaceId} nodeIds=${JSON.stringify(event.nodeIds)} kind=${event.kind ?? ''} sock=${sockPath}`);

    let settled = false;
    const done = (reason: string) => {
      if (settled) return;
      settled = true;
      debugLog(`notify done reason=${reason} elapsed=${Date.now() - startedAt}ms`);
      resolve();
    };

    let socket: net.Socket;
    try {
      socket = net.createConnection(sockPath);
    } catch (err) {
      debugLog(`notify createConnection threw: ${String(err)}`);
      done('createConnection-threw');
      return;
    }

    // Generous timeout: when the Electron main process is busy serving
    // canvas:save traffic from the renderer (e.g. the scrollback autosave
    // interval firing while an agent produces output), the server's
    // `accept()` may be delayed well beyond the ~1ms a local Unix socket
    // usually takes. A tight timeout here silently loses notifications
    // exactly in the scenario they matter most. 2s is still short enough
    // to not noticeably stall CLI commands if Electron isn't running.
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
