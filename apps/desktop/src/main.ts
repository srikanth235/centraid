import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installAuthInjector } from './main/auth-injector.js';
import { installCrashHandlers } from './main/crash-log.js';
import { startGatewayMonitor, stopGatewayMonitor } from './main/gateway-monitor.js';
import { registerIpcHandlers } from './main/ipc.js';
import { markLocalGatewaysDisposed, shutdownAllLocalGatewaysExcept } from './main/local-gateway.js';
import { ensurePhoneLink, shutdownPhoneLink } from './main/phone-link.js';
import { startReminderMonitor, stopReminderMonitor } from './main/reminder-monitor.js';
import { loadSettings } from './main/settings.js';
import { startUpdateWatcher } from './main/update-watcher.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Installed before `app.whenReady()` so even an early-boot failure (module
// init, a settings read that runs ahead of the window) gets captured.
// Deliberate log-and-continue posture — see crash-log.ts's doc comment.
installCrashHandlers();

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

void app.whenReady().then(async () => {
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
  }
  void installAuthInjector();
  registerIpcHandlers();
  // Boot the active gateway before showing the window (issue #351). Before
  // this, a `serve()` failure during lazy startup only surfaced as a failed
  // IPC invoke the FIRST time the renderer called `getSettings()` — no
  // dialog, and (pre-supervision) every subsequent settings read just
  // retried the same failing start immediately. `loadSettings()` resolves
  // the active gateway (starting the embedded local runtime when it's the
  // active one) and local-gateway.ts's supervisor now owns backed-off
  // background retries — this is just the "tell the user something's
  // wrong" surface for a launch-time failure, not itself a retry loop.
  try {
    await loadSettings();
  } catch (err) {
    dialog.showErrorBox(
      'Centraid gateway failed to start',
      `The embedded gateway could not start:\n\n${err instanceof Error ? err.message : String(err)}\n\n` +
        'Centraid will keep retrying automatically in the background.',
    );
  }
  createWindow();
  // Relaunch-to-update: watch the built dist for a newer build landing while
  // the app runs; the sidebar shows a "Relaunch to update" pill when one does.
  startUpdateWatcher();
  // Gateway runtime watch: heartbeat the active gateway, keep the
  // per-launch uptime history, and fire the OS down-alert. Lives in main
  // so it survives navigation and alerts land while backgrounded.
  startGatewayMonitor();
  // Task/event reminder watch: poll due `remind_before_min`/`reminders_json`
  // alerts and fire an OS notification for each new one. Same "lives in
  // main so it survives backgrounding" posture as the gateway monitor above.
  startReminderMonitor();
  // Phone link (issue #263): bring the iroh endpoint up front so paired
  // phones reconnect without any UI open. Failures surface in the
  // Settings → Phone panel via PHONE_STATUS; they must not block launch.
  ensurePhoneLink().catch((err) => {
    process.stdout.write(`[phone-link] failed to start: ${String(err)}\n`);
  });
  // Remote template refresh now runs inside the embedded gateway (issue
  // #141, Phase 5): `local-gateway` passes the configured remote manifest
  // URL into `serve()`, and the gateway's `/centraid/_templates` route
  // fires a one-time best-effort fetch into its cache. The desktop main
  // process no longer touches `@centraid/blueprints`.
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

/**
 * Graceful quit (issue #351). Before this, quitting the app never closed
 * the embedded gateway's SQLite handles — `gateway.stop()` (WAL checkpoint
 * + `db.close()`, wired through `GatewayServeHandle.close()`) only ran on
 * an explicit gateway *switch*. Every normal quit was, from SQLite's
 * perspective, a crash.
 *
 * `before-quit` is cancelable, so we intercept the first one, run the
 * async teardown, then call `app.quit()` ourselves — which re-fires
 * `before-quit`; the `quitting` guard lets that second pass through
 * instead of looping. A hard cap bounds the wait so a wedged gateway
 * can't hang the whole app on quit.
 */
const QUIT_TEARDOWN_TIMEOUT_MS = 5000;
let quitting = false;

app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  event.preventDefault();

  // Stop taking on new supervised-restart work first — a scheduled
  // auto-retry firing mid-teardown would otherwise resurrect a gateway we
  // just told to close.
  markLocalGatewaysDisposed();
  stopGatewayMonitor();
  stopReminderMonitor();

  const teardown = Promise.allSettled([
    // Every local gateway — WAL checkpoint + close (issue #1 above).
    shutdownAllLocalGatewaysExcept(),
    // The iroh phone tunnel holds its own endpoint + device store.
    shutdownPhoneLink(),
  ]);
  const timeout = new Promise<void>((resolve) => {
    const t = setTimeout(resolve, QUIT_TEARDOWN_TIMEOUT_MS);
    t.unref?.();
  });

  void Promise.race([teardown, timeout]).finally(() => {
    app.quit();
  });
});
