/**
 * Local IPC socket server that accepts canvas-update events from the
 * canvas-cli notifier and rebroadcasts them to all renderer windows.
 *
 * Listens on a Unix domain socket (POSIX) or named pipe (Windows) at the
 * well-known path returned by canvas-cli's `getIpcSocketPath`. Each client
 * connection sends one line of JSON then disconnects:
 *
 *   {"type":"canvas:updated","workspaceId":"...","nodeIds":["..."],"source":"cli"}
 *
 * On receipt, the event is forwarded to every BrowserWindow via
 * webContents.send('canvas:external-update', payload).
 */
import net from 'net';
import { promises as fs, existsSync, appendFileSync } from 'fs';
import { dirname, join } from 'path';
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
 * Must stay in sync with `getIpcSocketPath` in
 * packages/canvas-cli/src/core/notifier.ts. Keeping a local copy avoids
 * introducing a workspace dep from the Electron main bundle into the CLI
 * package, which would require bundling its source into the Electron build.
 */
/**
 * Socket lives under the OS temp dir rather than `$HOME/.pulse-coder` so
 * that sandboxed child processes (e.g. commands launched by Codex/Claude
 * CLI under macOS Seatbelt) can still reach it — the default Seatbelt
 * profile denies writes and unix-socket connects under `$HOME` but
 * permits them under `$TMPDIR`.
 */
const getIpcSocketPath = (): string => {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\pulse-coder-canvas-ipc';
  }
  return join(tmpdir(), 'pulse-coder-canvas-ipc.sock');
};

/** Legacy path used by pre-TMPDIR builds; cleaned up on startup. */
const getLegacyIpcSocketPath = (): string =>
  join(homedir(), '.pulse-coder', 'canvas-ipc.sock');

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
  debugLog(`conn#${connId} accepted`);

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
  const socketPath = getIpcSocketPath();
  debugLog(`startCanvasIpcServer path=${socketPath}`);

  // On POSIX, stale socket files from a previous crash block binding.
  if (process.platform !== 'win32') {
    await fs.mkdir(dirname(socketPath), { recursive: true }).catch(() => undefined);
    // Remove leftover socket at the pre-TMPDIR path so nothing connects to
    // a dead file. Best-effort; no error if it doesn't exist.
    await fs.unlink(getLegacyIpcSocketPath()).catch(() => undefined);
    if (existsSync(socketPath)) {
      // Try connecting — if nothing answers, remove the stale file.
      await new Promise<void>((resolve) => {
        const probe = net.createConnection(socketPath);
        probe.once('connect', () => {
          probe.end();
          resolve();
        });
        probe.once('error', async () => {
          await fs.unlink(socketPath).catch(() => undefined);
          resolve();
        });
      });
    }
  }

  return new Promise((resolve, reject) => {
    const srv = net.createServer(handleConnection);
    srv.once('error', (err) => {
      console.warn('[canvas-ipc] failed to start server:', err);
      debugLog(`server error at listen: ${String(err)}`);
      reject(err);
    });
    srv.listen(socketPath, () => {
      server = srv;
      debugLog(`server listening`);
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
  if (process.platform !== 'win32') {
    try {
      const socketPath = getIpcSocketPath();
      if (existsSync(socketPath)) {
        void fs.unlink(socketPath).catch(() => undefined);
      }
    } catch {
      // ignore
    }
  }
};
