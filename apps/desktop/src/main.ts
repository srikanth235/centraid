import path from "node:path";

import { app, BrowserWindow, nativeImage, shell } from "electron";

import {
  installApplicationMenu,
  installDeepLinkProtocol,
  installTray,
  setTrayGatewayRunning,
} from "./main/app-chrome.js";
import { installAuthInjector } from "./main/auth-injector.js";
import { installCrashHandlers } from "./main/crash-log.js";
import {
  nudgeGatewayMonitor,
  startGatewayMonitor,
  stopGatewayMonitor,
} from "./main/gateway-monitor.js";
import { registerIpcHandlers } from "./main/ipc.js";
import {
  markLocalGatewaysDisposed,
  shutdownAllLocalGatewaysExcept,
} from "./main/local-gateway.js";
import { applyLaunchAtLogin } from "./main/login-item.js";
import { ensurePhoneLink, shutdownPhoneLink } from "./main/phone-link.js";
import { registerPowerContextListeners } from "./main/power-context-push.js";
import {
  startReminderMonitor,
  stopReminderMonitor,
} from "./main/reminder-monitor.js";
import { loadSettings } from "./main/settings.js";
import { startUpdateWatcher } from "./main/update-watcher.js";
import { loadWindowState, trackWindowState } from "./main/window-state.js";

const __dirname = import.meta.dirname;

// Single-instance lock (#351): a second copy boots a second gateway on one
// vault. Startup stays in the `else` — an unconditional `app.whenReady()` can
// beat the queued `quit()`.
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (gotSingleInstanceLock) {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  installCrashHandlers();
  installDeepLinkProtocol();

  const ICON_PATH = path.join(__dirname, "..", "icon.png");

  let flushWindowState: (() => void) | undefined;

  const canOpenExternal = (url: string): boolean => {
    try {
      return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  };

  const createWindow = (): void => {
    const state = loadWindowState();
    const win = new BrowserWindow({
      backgroundColor: "#e8e9ec",
      height: state.height,
      width: state.width,
      x: state.x,
      y: state.y,
      icon: ICON_PATH,
      minHeight: 720,
      minWidth: 1100,
      titleBarStyle: "hiddenInset",
      trafficLightPosition: { x: 16, y: 16 },
      // Revealed on first paint below: no empty-window flash (#659).
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(__dirname, "preload.cjs"),
        sandbox: true,
      },
    });
    if (state.isMaximized) win.maximize();
    flushWindowState = trackWindowState(win);

    // Both listeners: a window that never fires `ready-to-show` stays invisible.
    const reveal = (): void => {
      if (win.isDestroyed() || win.isVisible()) return;
      win.show();
    };
    win.once("ready-to-show", reveal);
    win.webContents.once("did-finish-load", reveal);

    void win.loadFile(path.join(__dirname, "renderer", "index.html"));

    win.webContents.setWindowOpenHandler(({ url }) => {
      if (canOpenExternal(url)) {
        void shell.openExternal(url);
      }
      return { action: "deny" };
    });

    win.webContents.on(
      "console-message",
      (_event, level, message, line, source) => {
        const prefix = level >= 2 ? "RENDERER-ERR" : "RENDERER";
        process.stdout.write(`[${prefix}] ${message} (${source}:${line})\n`);
      }
    );
  };

  void app.whenReady().then(async () => {
    if (process.platform === "darwin" && app.dock) {
      app.dock.setIcon(nativeImage.createFromPath(ICON_PATH));
    }
    installApplicationMenu();
    installTray(ICON_PATH);
    // Not a bare `void`: rejects on every gateway-less launch, logging as a crash.
    installAuthInjector().catch((error: unknown) => {
      process.stdout.write(
        `[auth-injector] not installed yet: ${error instanceof Error ? error.message : String(error)}\n`
      );
    });
    registerIpcHandlers();
    // Window first: an error modal with no window behind it hangs unattended
    // launches; failures render in-window via `getSettings()`.
    createWindow();
    // First run starts no local gateway (#603): no keychain prompt before choosing.
    try {
      const settings = await loadSettings();
      // Every launch, not just on change: reconciles an OS login-item reset.
      applyLaunchAtLogin(settings.launchAtLogin);
      setTrayGatewayRunning(settings.gatewayUrl.length > 0);
    } catch (error) {
      setTrayGatewayRunning(false);
      process.stdout.write(
        `[startup] gateway did not start: ${error instanceof Error ? error.message : String(error)}\n`
      );
    }
    startUpdateWatcher();
    // In main so they survive navigation and alert while backgrounded (#528).
    startGatewayMonitor();
    registerPowerContextListeners(() => nudgeGatewayMonitor());
    startReminderMonitor();
    // Must not block launch (#263); failures surface in Settings → Phone.
    ensurePhoneLink().catch((error) => {
      process.stdout.write(`[phone-link] failed to start: ${String(error)}\n`);
    });
    // Templates and harness detection belong to the gateway (#141): main must
    // not touch `@centraid/blueprints`.
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

  // Graceful quit (#351 / #468 H1): detached children outlive the UI; only
  // embedded gateways get the WAL checkpoint. `before-quit` is cancelable, so
  // the `quitting` guard passes the re-fire through.
  const QUIT_TEARDOWN_TIMEOUT_MS = 5000;
  let quitting = false;

  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    flushWindowState?.();

    // First: a mid-teardown auto-retry would resurrect a closing gateway.
    markLocalGatewaysDisposed();
    stopGatewayMonitor();
    stopReminderMonitor();

    const teardown = Promise.allSettled([
      shutdownAllLocalGatewaysExcept(),
      shutdownPhoneLink(),
    ]);
    // Not unref'd: this deadline must fire when teardown wedges.
    let cap: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      cap = setTimeout(resolve, QUIT_TEARDOWN_TIMEOUT_MS);
    });

    void Promise.race([teardown, timeout]).finally(() => {
      if (cap) clearTimeout(cap);
      app.quit();
    });
  });
} else {
  app.quit();
}
