import { ipcMain } from "electron";
import * as pty from "node-pty";
import { platform, homedir } from "os";
import { execSync } from "child_process";
import { existsSync } from "fs";

const sessions = new Map<string, pty.IPty>();

const defaultShell = () => {
  if (platform() === "win32") return "powershell.exe";
  // process.env.SHELL may be unset when launched from macOS GUI / Finder
  const candidates = [
    process.env.SHELL,
    "/bin/zsh",
    "/bin/bash",
    "/usr/bin/zsh",
    "/usr/bin/bash",
  ];
  for (const s of candidates) {
    if (s && existsSync(s)) return s;
  }
  return "/bin/sh";
};

const getCwd = (pid: number): string | null => {
  try {
    if (platform() === "darwin") {
      const out = execSync(`lsof -a -d cwd -p ${pid} -Fn 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 2000
      });
      const match = out.match(/\nn(.+)/);
      return match ? match[1] : null;
    }
    if (platform() === "linux") {
      const out = execSync(`readlink /proc/${pid}/cwd 2>/dev/null`, {
        encoding: "utf-8",
        timeout: 2000
      });
      return out.trim() || null;
    }
    return null;
  } catch {
    return null;
  }
};

export const setupPtyIpc = () => {
  ipcMain.handle(
    "pty:spawn",
    (
      _event,
      payload: { id: string; cols?: number; rows?: number; cwd?: string; workspaceId?: string }
    ) => {
      const { id, cols = 80, rows = 24, cwd, workspaceId } = payload;

      if (sessions.has(id)) {
        return { ok: true, reused: true };
      }

      try {
        const shell = defaultShell();
        const spawnEnv: Record<string, string> = {
          ...(process.env as Record<string, string>),
        };
        if (workspaceId) {
          spawnEnv.PULSE_CANVAS_WORKSPACE_ID = workspaceId;
        }
        const proc = pty.spawn(shell, [], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: cwd || homedir(),
          env: spawnEnv
        });

        sessions.set(id, proc);

        proc.onData((data: string) => {
          const win = _event.sender;
          if (!win.isDestroyed()) {
            win.send(`pty:data:${id}`, data);
          }
        });

        proc.onExit(({ exitCode }) => {
          sessions.delete(id);
          const win = _event.sender;
          if (!win.isDestroyed()) {
            win.send(`pty:exit:${id}`, exitCode);
          }
        });

        return { ok: true, pid: proc.pid };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle("pty:getCwd", (_event, payload: { id: string }) => {
    const proc = sessions.get(payload.id);
    if (!proc) return { ok: false, error: "session not found" };
    const cwd = getCwd(proc.pid);
    return { ok: true, cwd };
  });

  ipcMain.on("pty:write", (_event, payload: { id: string; data: string }) => {
    const proc = sessions.get(payload.id);
    if (proc) proc.write(payload.data);
  });

  ipcMain.on(
    "pty:resize",
    (_event, payload: { id: string; cols: number; rows: number }) => {
      const proc = sessions.get(payload.id);
      if (proc) {
        try {
          proc.resize(payload.cols, payload.rows);
        } catch {
          // ignore resize errors on dead pty
        }
      }
    }
  );

  ipcMain.on("pty:kill", (_event, payload: { id: string }) => {
    const proc = sessions.get(payload.id);
    if (proc) {
      proc.kill();
      sessions.delete(payload.id);
    }
  });
};

export const killAllPty = () => {
  for (const [id, proc] of sessions) {
    try {
      proc.kill();
    } catch {
      // ignore
    }
    sessions.delete(id);
  }
};

// --- Exec API for MCP harness ---

/**
 * Execute a command in an existing PTY session and collect output.
 * Uses a unique marker to delimit command output from the scrollback.
 */
export function execInSession(
  sessionId: string,
  command: string,
  opts?: { timeout?: number }
): Promise<{ ok: boolean; output?: string; error?: string }> {
  const proc = sessions.get(sessionId);
  if (!proc) {
    return Promise.resolve({ ok: false, error: `PTY session not found: ${sessionId}` });
  }

  const timeout = opts?.timeout ?? 30_000;
  const marker = `__HARNESS_${Date.now()}_${Math.random().toString(36).slice(2, 8)}__`;
  const endMarker = `__HARNESS_END_${marker}__`;

  return new Promise((resolve) => {
    let output = '';
    let capturing = false;
    let resolved = false;

    const cleanup = () => {
      disposable.dispose();
      clearTimeout(timer);
    };

    const finish = (result: { ok: boolean; output?: string; error?: string }) => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({ ok: true, output: output.trim() });
    }, timeout);

    const disposable = proc.onData((data: string) => {
      if (resolved) return;

      // Start capturing after we see our start marker
      if (!capturing) {
        const markerIdx = data.indexOf(marker);
        if (markerIdx !== -1) {
          capturing = true;
          // Capture everything after the marker line
          const afterMarker = data.slice(markerIdx + marker.length);
          const newlineIdx = afterMarker.indexOf('\n');
          if (newlineIdx !== -1) {
            output += afterMarker.slice(newlineIdx + 1);
          }
        }
      } else {
        output += data;
      }

      // Check for end marker
      if (capturing && output.includes(endMarker)) {
        const endIdx = output.indexOf(endMarker);
        // Get output before the echo command for end marker
        // The end marker echo command itself shows up, so trim it
        let finalOutput = output.slice(0, endIdx);
        // Remove the trailing echo command line (e.g. "echo __HARNESS_END_...__\r\n")
        const lastNewline = finalOutput.lastIndexOf('\n');
        if (lastNewline !== -1) {
          const lastLine = finalOutput.slice(lastNewline + 1);
          if (lastLine.includes('echo') && lastLine.includes(endMarker.slice(0, 20))) {
            finalOutput = finalOutput.slice(0, lastNewline);
          }
        }
        finish({ ok: true, output: finalOutput.trim() });
      }
    });

    // Write: echo start marker, run command, echo end marker
    proc.write(`echo ${marker}\r`);
    proc.write(`${command}\r`);
    proc.write(`echo ${endMarker}\r`);
  });
}

/** Check if a PTY session exists */
export function hasSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Get the PID of a PTY session (for cwd lookup etc.) */
export function getSessionPid(sessionId: string): number | null {
  const proc = sessions.get(sessionId);
  return proc ? proc.pid : null;
}
