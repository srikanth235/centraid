import { app, BrowserWindow, protocol, shell } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { disposeWindowSession, registerIpcHandlers } from "./main/ipc.js";
import {
  PREVIEW_SCHEME,
  registerPreviewProtocol,
} from "./main/preview-protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Custom scheme that serves an unpublished project's local files into the
// builder's preview iframe. Must be marked privileged BEFORE `app.whenReady`
// for module scripts and `fetch` to behave like a real origin inside the
// iframe (matches what the gateway provides for published apps).
protocol.registerSchemesAsPrivileged([
  {
    scheme: PREVIEW_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
    },
  },
]);

function canOpenExternal(url: string): boolean {
  try {
    return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    backgroundColor: "#e8e9ec",
    height: 900,
    minHeight: 720,
    minWidth: 1100,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: true,
    },
    width: 1400,
  });

  void win.loadFile(path.join(__dirname, "renderer", "index.html"));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (canOpenExternal(url)) {
      void shell.openExternal(url);
    }
    return { action: "deny" };
  });

  win.webContents.on("console-message", (_event, level, message, line, source) => {
    const prefix = level >= 2 ? "RENDERER-ERR" : "RENDERER";
    process.stdout.write(`[${prefix}] ${message} (${source}:${line})\n`);
  });

  win.on("closed", () => {
    void disposeWindowSession(win.id);
  });
}

app.whenReady().then(() => {
  registerPreviewProtocol();
  registerIpcHandlers();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
