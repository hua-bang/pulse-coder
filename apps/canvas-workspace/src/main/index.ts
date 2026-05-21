import { app, BrowserWindow, ipcMain, net, protocol, shell } from "electron";
import { existsSync, promises as fs } from "fs";
import { dirname, join, normalize, isAbsolute } from "path";
import { fileURLToPath, pathToFileURL } from "url";
import { setupPtyIpc, killAllPty } from "./pty-manager";
import { setupCanvasStoreIpc, teardownCanvasWatchers } from "./canvas-store";
import { setupFileManagerIpc } from "./file-manager";
// MCP server disabled — canvas-cli is the preferred agent interface now.
// import { startMCPServer } from "./mcp-server";
// import { ensureMCPRegistered } from "./mcp-registration";
import { setupFileWatcherIpc, teardownFileWatcher } from "./file-watcher";
import { setupSkillInstallerIpc } from "./skill-installer";
import { setupCanvasAgentIpc, teardownCanvasAgent } from "./canvas-agent-ipc";
import { setupCanvasModelIpc } from "./canvas-model-ipc";
import { setupCanvasPromptIpc } from "./canvas-prompt-ipc";
import { setupWebviewRegistryIpc } from "./webview-registry";
import { setupHtmlGeneratorIpc } from "./html-generator-ipc";
import { setupArtifactIpc } from "./artifact-ipc";
import { setupShellIpc, isSafeExternalUrl } from "./shell-ipc";
import { setupWebpageReaderIpc } from "./webpage-reader-ipc";
import { BUILT_IN_MAIN_PLUGINS, setupCanvasPlugins } from "../plugins/main";

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

// Custom scheme for serving local image/file assets to the renderer.
// Chromium blocks `file://` URLs in renderer-loaded pages for security
// reasons, so any <img src="file://…"> from disk fails to load. We expose
// the same bytes under `pulse-canvas://local/<absolute-path>` so the
// renderer can reference local files without disabling webSecurity.
//
// This MUST run before `app.whenReady()` — privileged scheme registration
// is only effective during app startup.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "pulse-canvas",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      bypassCSP: true,
    },
  },
]);

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

const registerPulseCanvasProtocol = () => {
  protocol.handle("pulse-canvas", async (request) => {
    try {
      const url = new URL(request.url);
      if (url.hostname !== "local") {
        return new Response("Unsupported host", { status: 400 });
      }
      // pathname is like "/Users/foo/.pulse-coder/canvas/ws-x/images/img.png"
      // — percent-decode each segment, then join with the platform separator.
      const segments = url.pathname.split("/").map((s) => {
        try {
          return decodeURIComponent(s);
        } catch {
          return s;
        }
      });
      const joined = segments.join("/");
      const normalized = normalize(joined);
      if (!isAbsolute(normalized)) {
        return new Response("Path must be absolute", { status: 400 });
      }
      // Reject path traversal attempts after normalization.
      if (normalized.includes("..")) {
        return new Response("Forbidden", { status: 403 });
      }
      // Defer existence checks to fetch — it returns the right status code.
      return net.fetch(pathToFileURL(normalized).toString());
    } catch (error) {
      void writeLog("protocol", "pulse-canvas handler failed", String(error));
      return new Response("Internal error", { status: 500 });
    }
  });
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
      contextIsolation: true,
      // Enable <webview> so iframe/link canvas nodes can host a real
      // webContents. Main-process code reaches into each webview via its
      // webContents ID to pull rendered DOM text for the Canvas Agent.
      webviewTag: true
    }
  });

  // The main renderer should never navigate away from the app shell. If a
  // sandboxed iframe somehow tries to top-navigate, push the URL to the OS
  // browser and cancel the load. (Popups from this webContents are handled
  // by the app-level `web-contents-created` listener below.)
  win.webContents.on("will-navigate", (event, url) => {
    if (url === win.webContents.getURL()) return;
    event.preventDefault();
    if (isSafeExternalUrl(url)) {
      void shell.openExternal(url);
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

// Centralized popup policy. Fires for every webContents the app ever
// creates: the main BrowserWindow, sandboxed `<iframe>`s within it, and
// every `<webview>` tag mounted by an iframe canvas node. The handler is
// installed before the embedded page can run any JavaScript, which is the
// only timing that survives SPA-driven `window.open` calls in Lark /
// Feishu / Notion docs — anything later misses the popup and the click
// looks dead to the user.
//
// Instead of opening every intercepted URL in the system browser, forward
// it to the host renderer (the BrowserWindow this webContents lives in)
// over the `link:open` channel. The renderer surfaces it in a side
// drawer with a webview preview and explicit "open in system browser" /
// "add to current canvas" actions.
//
// `will-navigate` is also forwarded so that SPAs (Lark wiki etc.) which
// use `location.assign` or plain `<a href>` for cross-origin links land
// in the drawer instead of dying silently inside the embed.
function forwardLinkToRenderer(contents: Electron.WebContents, url: string) {
  // For `<webview>`, the message must reach the embedder (the main
  // renderer hosting the drawer), not the guest itself. `hostWebContents`
  // is undefined for top-level webContents — there, `contents` already IS
  // the renderer we want to talk to.
  const target = contents.hostWebContents ?? contents;
  if (target.isDestroyed()) return;
  target.send("link:open", { url });
}

app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (!isSafeExternalUrl(url)) return { action: "deny" };

    // OAuth-style popups: `window.open(url, '_blank', 'width=…,height=…')`
    // surfaces here as `disposition === 'new-window'`. These need a real
    // window — the page reads back the returned `window` reference and
    // relies on `window.opener.postMessage` / `window.close` to finish
    // the auth round-trip. If we deny them, the site shows a "popups
    // blocked" prompt (Notion, Google, etc. all do this).
    //
    // Letting Electron create the popup as a regular BrowserWindow keeps
    // sessions/cookies shared with the opener (default session) and gives
    // the popup the standard chrome an OAuth dialog expects.
    if (disposition === "new-window") {
      return { action: "allow" };
    }

    // Everything else — `<a target="_blank">` (`foreground-tab`), bare
    // `window.open(url)` — is a "preview this link" intent, route to the
    // side drawer.
    forwardLinkToRenderer(contents, url);
    return { action: "deny" };
  });

  if (contents.getType() === "webview") {
    contents.on("will-navigate", (event, url) => {
      const currentUrl = contents.getURL();
      let crossOrigin = false;
      try {
        crossOrigin = new URL(url).origin !== new URL(currentUrl).origin;
      } catch {
        crossOrigin = true;
      }
      if (crossOrigin && isSafeExternalUrl(url)) {
        event.preventDefault();
        forwardLinkToRenderer(contents, url);
      }
    });
  }
});

app.whenReady().then(() => {
  // Notion (and a handful of other services) reject embedded `<webview>`s
  // on two grounds: the UA string contains the "Electron/x.y.z" token, AND
  // the Chrome major version bundled with Electron 30 (Chromium 124) is now
  // below their supported floor. Both checks surface the same "Your browser
  // is not compatible" page even though the underlying Chromium renders the
  // app fine. Strip the Electron / product-name tokens and rewrite the
  // Chrome version to a recent stable release so each webContents looks
  // like a current stock Chrome. Must run before any webContents navigates.
  //
  // We use UA-Reduction's `X.0.0.0` minor format — that matches what stock
  // Chrome itself sends now, so we don't have to track real build numbers.
  const SPOOFED_CHROME_MAJOR = "140";
  app.userAgentFallback = app.userAgentFallback
    .replace(/\s?Electron\/\S+/g, "")
    .replace(/\s?PulseCanvas\/\S+/g, "")
    .replace(/Chrome\/\d+(?:\.\d+){0,3}/g, `Chrome/${SPOOFED_CHROME_MAJOR}.0.0.0`);

  registerPulseCanvasProtocol();

  // Set the macOS dock icon in dev/preview (packaged builds use the .icns
  // from electron-builder, so this is a no-op there).
  if (process.platform === "darwin" && resolvedIconPath && app.dock) {
    try {
      app.dock.setIcon(resolvedIconPath);
    } catch (error) {
      void writeLog("main", "dock.setIcon failed", String(error));
    }
  }

  // About panel: shown by the native menu (macOS: Pulse Canvas > About;
  // Linux: Help > About). iconPath is honored on Linux/Windows; macOS
  // reads the icon from the app bundle.
  app.setAboutPanelOptions({
    applicationName: "Pulse Canvas",
    applicationVersion: app.getVersion(),
    copyright: "Copyright © 2025",
    ...(resolvedIconPath ? { iconPath: resolvedIconPath } : {})
  });

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
  setupCanvasModelIpc();
  setupCanvasPromptIpc();
  setupWebviewRegistryIpc();
  setupHtmlGeneratorIpc();
  setupArtifactIpc();
  setupShellIpc();
  setupWebpageReaderIpc();
  void setupCanvasPlugins(BUILT_IN_MAIN_PLUGINS);
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
