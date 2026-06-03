import { app, BrowserWindow, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAuthInjector } from './main/auth-injector.js';
import { registerIpcHandlers } from './main/ipc.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Icon lives at the package root (../../icon.png from dist/main.js); used
// for the BrowserWindow on Windows/Linux and the macOS dock during dev.
// Packaged builds will pick up the .icns via electron-builder config.
const ICON_PATH = path.join(__dirname, '..', 'icon.png');

// The builder preview iframe is served by the gateway itself (issue #141,
// Phase 4): it points at `/centraid/_draft/<sessionId>/<id>/`, a real HTTP
// origin the main-process auth-injector authenticates. No custom local
// scheme is needed anymore — the old `centraid-preview://` path-mode
// protocol was retired so local == remote serving.

function canOpenExternal(url: string): boolean {
  try {
    return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    backgroundColor: '#e8e9ec',
    height: 900,
    icon: ICON_PATH,
    minHeight: 720,
    minWidth: 1100,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.cjs'),
      sandbox: true,
    },
    width: 1400,
  });

  void win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (canOpenExternal(url)) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  win.webContents.on('console-message', (_event, level, message, line, source) => {
    const prefix = level >= 2 ? 'RENDERER-ERR' : 'RENDERER';
    process.stdout.write(`[${prefix}] ${message} (${source}:${line})\n`);
  });
}

app.whenReady().then(() => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
  }
  void installAuthInjector();
  registerIpcHandlers();
  createWindow();
  // Remote template refresh now runs inside the embedded gateway (issue
  // #141, Phase 5): `local-runtime` passes the configured remote manifest
  // URL into `serve()`, and the gateway's `/centraid/_templates` route
  // fires a one-time best-effort fetch into its cache. The desktop main
  // process no longer touches `@centraid/app-blueprints`.
  // Coding-agent detection moved to the gateway (`GET /centraid/_agents/status`):
  // it's colocated with the runner and probes its own host on demand, so the
  // desktop no longer runs a first-launch credential probe.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
