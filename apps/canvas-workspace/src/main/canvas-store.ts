import { ipcMain } from "electron";
import { promises as fs } from "fs";
import { join } from "path";
import { homedir } from "os";

const STORE_DIR = join(homedir(), ".pulse-coder", "canvas");
const getFilePath = (id: string) =>
  join(STORE_DIR, `${id.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`);

export const setupCanvasStoreIpc = () => {
  ipcMain.handle(
    "canvas:save",
    async (_event, payload: { id: string; data: unknown }) => {
      try {
        await fs.mkdir(STORE_DIR, { recursive: true });
        const filePath = getFilePath(payload.id);
        await fs.writeFile(filePath, JSON.stringify(payload.data, null, 2), "utf-8");
        return { ok: true };
      } catch (err) {
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle(
    "canvas:load",
    async (_event, payload: { id: string }) => {
      try {
        const filePath = getFilePath(payload.id);
        const raw = await fs.readFile(filePath, "utf-8");
        return { ok: true, data: JSON.parse(raw) };
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") {
          return { ok: true, data: null };
        }
        return { ok: false, error: String(err) };
      }
    }
  );

  ipcMain.handle("canvas:list", async () => {
    try {
      await fs.mkdir(STORE_DIR, { recursive: true });
      const files = await fs.readdir(STORE_DIR);
      const ids = files
        .filter((f) => f.endsWith(".json"))
        .map((f) => f.replace(/\.json$/, ""));
      return { ok: true, ids };
    } catch (err) {
      return { ok: false, error: String(err) };
    }
  });

  ipcMain.handle(
    "canvas:delete",
    async (_event, payload: { id: string }) => {
      try {
        await fs.unlink(getFilePath(payload.id));
        return { ok: true };
      } catch (err: unknown) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return { ok: true };
        return { ok: false, error: String(err) };
      }
    }
  );
};
