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
      payload: { id: string; cols?: number; rows?: number; cwd?: string }
    ) => {
      const { id, cols = 80, rows = 24, cwd } = payload;

      if (sessions.has(id)) {
        return { ok: true, reused: true };
      }

      try {
        const shell = defaultShell();
        const proc = pty.spawn(shell, [], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: cwd || homedir(),
          env: process.env as Record<string, string>
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
