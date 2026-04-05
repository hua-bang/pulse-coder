/**
 * Local IPC server that accepts canvas-update events from the canvas-cli
 * notifier and rebroadcasts them to all renderer windows.
 *
 * Transport: loopback TCP on an OS-assigned port. The chosen port is
 * written to `$TMPDIR/pulse-coder-canvas-ipc.port` on startup so the
 * canvas-cli notifier can discover it.
 *
 * Why TCP and not a Unix domain socket: sandboxed child processes
 * launched by CLI agents (e.g. Codex under macOS Seatbelt) run with
 * `network-outbound` limited to `(remote tcp)` / `(remote udp)`.
 * Unix socket `connect()` is denied with `EPERM` regardless of the
 * socket path, so we use plain TCP loopback which the sandbox permits.
 *
 * Protocol: one line of JSON per connection, then the client disconnects:
 *
 *   {"type":"canvas:updated","workspaceId":"...","nodeIds":["..."],"source":"cli"}
 *
 * On receipt, the event is forwarded to every BrowserWindow via
 * webContents.send('canvas:external-update', payload).
 */
import net from 'net';
import { promises as fs, appendFileSync } from 'fs';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { BrowserWindow } from 'electron';

const DEBUG_LOG_PATH = join(tmpdir(), 'pulse-coder-canvas-ipc-server.log');
let connectionSeq = 0;

const debugLog = (msg: string): void => {
  try {
    const ts = new Date().toISOString();
    appendFileSync(DEBUG_LOG_PATH, `[${ts}] pid=${process.pid} ${msg}\n`);
  } catch {
    // ignore — logging must never crash main
  }
};

/**
 * Path where the chosen TCP port is published. Must stay in sync with
 * `getIpcPortFilePath` in packages/canvas-cli/src/core/notifier.ts.
 * Keeping a local copy avoids introducing a workspace dep from the
 * Electron main bundle into the CLI package.
 */
const getIpcPortFilePath = (): string =>
  join(tmpdir(), 'pulse-coder-canvas-ipc.port');

/** Pre-TCP builds left artifacts under $HOME and $TMPDIR; clean them up. */
const getLegacyArtifactPaths = (): string[] => [
  join(homedir(), '.pulse-coder', 'canvas-ipc.sock'),
  join(tmpdir(), 'pulse-coder-canvas-ipc.sock'),
];

interface CanvasUpdateEvent {
  type: 'canvas:updated';
  workspaceId: string;
  nodeIds: string[];
  kind?: 'create' | 'update' | 'delete';
  source: 'cli';
}

let server: net.Server | null = null;

const broadcast = (event: CanvasUpdateEvent, connId: number) => {
  const wins = BrowserWindow.getAllWindows();
  debugLog(`conn#${connId} broadcast workspaceId=${event.workspaceId} nodeIds=${JSON.stringify(event.nodeIds)} kind=${event.kind ?? ''} windows=${wins.length}`);
  for (const win of wins) {
    if (win.isDestroyed()) continue;
    win.webContents.send('canvas:external-update', event);
  }
};

const handleConnection = (socket: net.Socket) => {
  const connId = ++connectionSeq;
  const acceptedAt = Date.now();
  debugLog(`conn#${connId} accepted from=${socket.remoteAddress}:${socket.remotePort}`);

  let buffer = '';
  let gotLine = false;
  socket.setEncoding('utf-8');
  socket.setTimeout(5000);

  socket.on('data', (chunk: string) => {
    debugLog(`conn#${connId} data +${chunk.length} bytes elapsed=${Date.now() - acceptedAt}ms`);
    buffer += chunk;
    let newlineIdx: number;
    while ((newlineIdx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newlineIdx).trim();
      buffer = buffer.slice(newlineIdx + 1);
      if (!line) continue;
      try {
        const event = JSON.parse(line) as CanvasUpdateEvent;
        if (event && event.type === 'canvas:updated' && event.workspaceId) {
          broadcast(event, connId);
        } else {
          debugLog(`conn#${connId} line rejected (bad shape): ${line.slice(0, 120)}`);
        }
        gotLine = true;
      } catch (err) {
        debugLog(`conn#${connId} JSON parse failed: ${String(err)} line=${line.slice(0, 120)}`);
      }
    }
    if (gotLine) {
      socket.end();
    }
  });

  socket.once('timeout', () => {
    debugLog(`conn#${connId} timeout after ${Date.now() - acceptedAt}ms`);
    socket.destroy();
  });
  socket.once('error', (err) => {
    debugLog(`conn#${connId} error: ${String(err)}`);
    socket.destroy();
  });
  socket.once('close', (hadError) => {
    debugLog(`conn#${connId} close hadError=${hadError} elapsed=${Date.now() - acceptedAt}ms`);
  });
};

export const startCanvasIpcServer = async (): Promise<void> => {
  debugLog(`startCanvasIpcServer (loopback TCP)`);

  // Best-effort cleanup of legacy unix-socket artifacts from older builds
  // so nothing stale lingers. Missing files are fine.
  for (const p of getLegacyArtifactPaths()) {
    await fs.unlink(p).catch(() => undefined);
  }

  return new Promise((resolve, reject) => {
    const srv = net.createServer(handleConnection);
    srv.once('error', (err) => {
      console.warn('[canvas-ipc] failed to start server:', err);
      debugLog(`server error at listen: ${String(err)}`);
      reject(err);
    });
    // Bind to loopback only so external hosts can't reach the bus.
    srv.listen({ host: '127.0.0.1', port: 0 }, async () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        const msg = `server listen returned unexpected address: ${String(addr)}`;
        debugLog(msg);
        reject(new Error(msg));
        return;
      }
      server = srv;
      debugLog(`server listening on ${addr.address}:${addr.port}`);
      try {
        await fs.writeFile(getIpcPortFilePath(), String(addr.port), 'utf-8');
      } catch (err) {
        debugLog(`failed to write port file: ${String(err)}`);
        // Non-fatal: server is still up, CLI just can't discover it.
      }
      resolve();
    });
  });
};

export const stopCanvasIpcServer = (): void => {
  if (!server) return;
  try {
    server.close();
  } catch {
    // ignore
  }
  server = null;
  void fs.unlink(getIpcPortFilePath()).catch(() => undefined);
};
