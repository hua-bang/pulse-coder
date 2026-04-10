import { app, BrowserWindow, ipcMain } from "electron";
import { existsSync, promises as fs } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { setupPtyIpc, killAllPty } from "./pty-manager";
import { setupCanvasStoreIpc, teardownCanvasWatchers } from "./canvas-store";
import { setupFileManagerIpc } from "./file-manager";
// MCP server disabled — canvas-cli is the preferred agent interface now.
// import { startMCPServer } from "./mcp-server";
// import { ensureMCPRegistered } from "./mcp-registration";
import { setupFileWatcherIpc, teardownFileWatcher } from "./file-watcher";
import { setupSkillInstallerIpc } from "./skill-installer";
import { setupCanvasAgentIpc, teardownCanvasAgent } from "./canvas-agent-ipc";

const currentDir = dirname(fileURLToPath(import.meta.url));
const preloadPath = join(currentDir, "../preload/index.mjs");
const preloadFallbackPath = join(currentDir, "../preload/index.js");
const resolvedPreloadPath = existsSync(preloadPath)
  ? preloadPath
  : preloadFallbackPath;

// Resolve the app icon for window/taskbar display. Works in dev, preview,
// and packaged builds (resources/ is shipped via electron-builder files).
const iconCandidates = [
  join(currentDir, "../../resources/icon.png"),
  join(currentDir, "../../build/icon.png"),
  join(process.resourcesPath ?? "", "resources/icon.png")
];
const resolvedIconPath = iconCandidates.find((p) => p && existsSync(p));
const logDir = join(app.getPath("userData"), "logs");
const logFile = join(logDir, "app.log");

const writeLog = async (level: string, message: string, details?: string) => {
  const timestamp = new Date().toISOString();
  const line = details
    ? `[${timestamp}] [${level}] ${message}\n${details}\n`
    : `[${timestamp}] [${level}] ${message}\n`;

  try {
    await fs.mkdir(logDir, { recursive: true });
    await fs.appendFile(logFile, line);
  } catch (error) {
    console.error("Failed to write log", error);
  }
};

const createWindow = () => {
  void writeLog("main", "preload", resolvedPreloadPath);
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#f6f6f4",
    ...(resolvedIconPath ? { icon: resolvedIconPath } : {}),
    webPreferences: {
      preload: resolvedPreloadPath,
      contextIsolation: true
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription) => {
    console.error("Renderer failed to load", errorCode, errorDescription);
    void writeLog(
      "renderer",
      `failed to load (${errorCode}) ${errorDescription}`
    );
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("Renderer process crashed", details.reason);
    void writeLog("renderer", `process gone: ${details.reason}`);
  });

  win.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      const details = `${sourceId}:${line}`;
      void writeLog("console", `L${level} ${message}`, details);
    }
  );

  if (process.env.ELECTRON_RENDERER_URL) {
    void writeLog("main", "loadURL", process.env.ELECTRON_RENDERER_URL);
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    const filePath = join(currentDir, "../renderer/index.html");
    void writeLog("main", "loadFile", filePath);
    win.loadFile(filePath);
  }
};

app.whenReady().then(() => {
  // Set the macOS dock icon in dev/preview (packaged builds use the .icns
  // from electron-builder, so this is a no-op there).
  if (process.platform === "darwin" && resolvedIconPath && app.dock) {
    try {
      app.dock.setIcon(resolvedIconPath);
    } catch (error) {
      void writeLog("main", "dock.setIcon failed", String(error));
    }
  }

  ipcMain.on("app:log", (_event, payload) => {
    const level = payload?.level ?? "renderer";
    const message = payload?.message ?? "log";
    const details = payload?.details;
    void writeLog(level, message, details);
  });

  process.on("uncaughtException", (error) => {
    console.error("Main uncaughtException", error);
    void writeLog("main", "uncaughtException", String(error?.stack ?? error));
  });

  process.on("unhandledRejection", (reason) => {
    console.error("Main unhandledRejection", reason);
    void writeLog("main", "unhandledRejection", String(reason));
  });

  setupPtyIpc();
  setupCanvasStoreIpc();
  setupFileManagerIpc();
  setupFileWatcherIpc();
  setupSkillInstallerIpc();
  setupCanvasAgentIpc();
  // MCP server disabled — canvas-cli is the preferred agent interface now.
  // startMCPServer();
  // void ensureMCPRegistered();

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  killAllPty();
  teardownFileWatcher();
  teardownCanvasWatchers();
  teardownCanvasAgent();
  if (process.platform !== "darwin") {
    app.quit();
  }
});
