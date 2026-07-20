import { app, BrowserWindow, dialog, nativeImage, shell } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  installApplicationMenu,
  installDeepLinkProtocol,
  installTray,
  setTrayGatewayRunning,
} from './main/app-chrome.js';
import { installAuthInjector } from './main/auth-injector.js';
import { installCrashHandlers } from './main/crash-log.js';
import { startGatewayMonitor, stopGatewayMonitor } from './main/gateway-monitor.js';
import { registerIpcHandlers } from './main/ipc.js';
import { applyLaunchAtLogin } from './main/login-item.js';
import { markLocalGatewaysDisposed, shutdownAllLocalGatewaysExcept } from './main/local-gateway.js';
import { ensurePhoneLink, shutdownPhoneLink } from './main/phone-link.js';
import { startReminderMonitor, stopReminderMonitor } from './main/reminder-monitor.js';
import { loadSettings } from './main/settings.js';
import { startUpdateWatcher } from './main/update-watcher.js';
import { loadWindowState, trackWindowState } from './main/window-state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/*
 * Single-instance lock (issue #351). Without this, launching a second copy
 * of the desktop app would boot a SECOND embedded gateway against the same
 * on-disk vault — two processes fighting over the same SQLite files. This
 * has to be the very first thing the process does, before crash-handler
 * install or anything else that does real work: a losing second instance
 * should hand off and exit before touching the filesystem at all, not after.
 *
 * The check is synchronous and cheap; when it fails, `app.quit()` is called
 * and the REST OF THIS FILE's startup — `app.whenReady()`, window creation,
 * the gateway boot — is skipped entirely by wrapping it in the `else` below
 * (the standard Electron pattern: letting `app.whenReady()` register
 * unconditionally risks it firing before the queued `quit()` takes effect).
 * Registering `second-instance` is what makes launching Centraid again from
 * the Dock / Start Menu / a second `open` just focus the existing window
 * instead of silently no-op'ing.
 */
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Deep-link second-instance handler is also registered in app-chrome;
  // this block focuses the window when the user re-launches without a URL.
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  // Installed before `app.whenReady()` so even an early-boot failure (module
  // init, a settings read that runs ahead of the window) gets captured.
  // Deliberate log-and-continue posture — see crash-log.ts's doc comment.
  installCrashHandlers();
  installDeepLinkProtocol();

  // Icon lives at the package root (../../icon.png from dist/main.js); used
  // for the BrowserWindow on Windows/Linux and the macOS dock during dev.
  // Packaged builds will pick up the .icns via electron-builder config
  // (appId: dev.centraid.desktop — electron-builder/app-id.json).
  const ICON_PATH = path.join(__dirname, '..', 'icon.png');

  // The builder preview iframe is served by the gateway itself (issue #141,
  // Phase 4): it points at `/centraid/_draft/<sessionId>/<id>/`, a real HTTP
  // origin the main-process auth-injector authenticates. No custom local
  // scheme is needed anymore — the old `centraid-preview://` path-mode
  // protocol was retired so local == remote serving.

  let flushWindowState: (() => void) | undefined;

  const canOpenExternal = (url: string): boolean => {
    try {
      return ['https:', 'http:', 'mailto:'].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  };

  const createWindow = (): void => {
    const state = loadWindowState();
    const win = new BrowserWindow({
      backgroundColor: '#e8e9ec',
      height: state.height,
      width: state.width,
      x: state.x,
      y: state.y,
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
    });
    if (state.isMaximized) win.maximize();
    flushWindowState = trackWindowState(win);

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
  };

  void app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) {
      app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
    }
    installApplicationMenu();
    installTray(ICON_PATH);
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
      const settings = await loadSettings();
      // Launch-at-login (issue #351, tier 4) — apply on every launch, not
      // just when the setting changes, so an OS-level login-item reset (or
      // a settings.json hand-edit) reconciles instead of drifting silently.
      applyLaunchAtLogin(settings.launchAtLogin);
      setTrayGatewayRunning(true);
    } catch (err) {
      setTrayGatewayRunning(false);
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
   * Graceful quit (issue #351 / #468 H1). Embedded (in-process) gateways
   * get a WAL checkpoint + close so SQLite doesn't see a crash. Detached
   * gateway children intentionally outlive the UI — `shutdownAllLocalGatewaysExcept`
   * skips `mode: 'detached'` handles so pairing, the browser extension,
   * and mobile keep a reachable vault after the window closes.
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
    // Flush window bounds before async teardown (issue #468 K13).
    flushWindowState?.();

    // Stop taking on new supervised-restart work first — a scheduled
    // auto-retry firing mid-teardown would otherwise resurrect a gateway we
    // just told to close. Detached children keep running; only the
    // supervisor timers + embedded servers are torn down.
    markLocalGatewaysDisposed();
    stopGatewayMonitor();
    stopReminderMonitor();

    const teardown = Promise.allSettled([
      // Embedded local gateways only — detached outlive the UI (#468 H1).
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
}
