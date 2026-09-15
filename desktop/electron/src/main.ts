/*
 * The desktop seat's main process (#1020 wave 3 lane F).
 *
 * Carried verbatim from v0's `main.ts` because each is a shipped-bug fix:
 * the single-instance lock with startup inside the `else` ("an unconditional
 * `app.whenReady()` can beat the queued `quit()`"), `contextIsolation` /
 * `nodeIntegration: false` / `sandbox: true`, `setWindowOpenHandler` denying
 * every window and opening only `https:`/`http:`/`mailto:` externally, the
 * window created **before** settings load so an error modal has a window behind
 * it, and `show: false` with BOTH `ready-to-show` and `did-finish-load` reveal
 * listeners.
 *
 * What is new is the seat: main spawns it, supervises it, holds its socket, and
 * **stops it on quit** (D-1020-F1). No CI or test branches live here — the
 * Playwright entry in `desktop/e2e/electron-entry.mjs` carries those, which is
 * why production main is free of them (census §F9).
 */

import path from "node:path";

import { app, BrowserWindow, Notification, shell } from "electron";

import { broadcastSeatState, registerIpcHandlers } from "./main/ipc.js";
import {
  installMediaProtocol,
  registerMediaScheme,
} from "./main/media-protocol.js";
import { connectSeat } from "./main/seat-socket.js";
import type { SeatConnection } from "./main/seat-socket.js";
import {
  alertNotification,
  applyState,
  DEFAULT_ALERT_SECONDS,
  evaluateAlerts,
  initialMonitorState,
} from "./main/seat-state-core.js";
import type { MonitorState, SeatState } from "./main/seat-state-core.js";
import { createSupervisor, spawnSidecar } from "./main/sidecar.js";
import type { SupervisedSeat } from "./main/sidecar.js";

// REGISTERED BEFORE READY. Electron reads the privileged-scheme table when the
// first renderer is created; a registration after that is silently ignored and
// shows up as a `<video>` that never loads, with no error anywhere.
registerMediaScheme();

const gotSingleInstanceLock = app.requestSingleInstanceLock();

// Startup stays inside this branch, never after an unconditional
// `app.whenReady()`: a second copy would boot a second seat over one vault, and
// an unconditional ready handler can beat the queued `quit()` (v0 `main.ts:36`).
if (gotSingleInstanceLock) {
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`);
  };

  const dataDir = (): string =>
    process.env["CENTRAID_DATA_DIR"] ??
    path.join(app.getPath("userData"), "vaultdata");
  const socketPath = (): string =>
    process.env["CENTRAID_SEAT_SOCKET"] ??
    path.join(app.getPath("userData"), "seat.sock");
  const seatBinary = (): string =>
    process.env["CENTRAID_BINARY"] ??
    path.join(process.resourcesPath ?? ".", "centraid");

  let connection: SeatConnection | undefined;
  let monitor: MonitorState = initialMonitorState();
  let lastState: unknown;

  const observeState = (state: unknown): void => {
    lastState = state;
    monitor = applyState(monitor, state as SeatState);
    const evaluated = evaluateAlerts(
      monitor,
      { enabled: true, thresholdSeconds: DEFAULT_ALERT_SECONDS },
      Date.now()
    );
    monitor = evaluated.monitor;
    for (const alert of evaluated.alerts) {
      const notification = alertNotification(alert);
      log(`[seat] ${notification.title}: ${notification.body}`);
      if (Notification.isSupported()) new Notification(notification).show();
    }
    broadcastSeatState(() => BrowserWindow.getAllWindows(), state);
  };

  const supervisor = createSupervisor({
    now: () => Date.now(),
    log,
    onCrashLoop: (message) => {
      const notification = alertNotification({ kind: "crash-loop", message });
      log(`[seat] ${notification.title}: ${notification.body}`);
      if (Notification.isSupported()) new Notification(notification).show();
    },
    start: async (): Promise<SupervisedSeat> => {
      const sidecar = await spawnSidecar({
        binary: seatBinary(),
        dataDir: dataDir(),
        socketPath: socketPath(),
        thin: process.env["CENTRAID_SEAT_THIN"] === "1",
        nonceFile: path.join(app.getPath("userData"), "seat.nonce"),
        log,
      });
      connection = await connectSeat({
        socketPath: socketPath(),
        nonce: sidecar.nonce,
        onState: observeState,
        onClosing: (reason) => log(`[seat] closing: ${reason}`),
        onDisconnect: (reason) => {
          log(`[seat] disconnected: ${reason}`);
          connection = undefined;
          // A seat that died after a clean start goes through the revival
          // budget, never straight back to `ensure`.
          void supervisor.revive().catch((error: unknown) => {
            log(`[seat] not revived: ${String(error)}`);
          });
        },
      });
      // The subscription's answer IS the first state, so the window never
      // draws from `undefined` after the seat is up.
      const first = await connection.request({ t: "subscribe_state" });
      observeState(first["state"]);
      return { sidecar, attached: true };
    },
    terminate: async (seat) => {
      if (!connection?.alive()) return;
      // The terminal command, and its answer is the seat's `closing` — which
      // is where the vault's last write lands. Awaited before any signal.
      await connection.request({ t: "terminate" }).catch(() => undefined);
      await seat.sidecar.waitForExit(5000);
      connection = undefined;
    },
  });

  const canOpenExternal = (url: string): boolean => {
    try {
      return ["https:", "http:", "mailto:"].includes(new URL(url).protocol);
    } catch {
      return false;
    }
  };

  const createWindow = (): void => {
    const win = new BrowserWindow({
      backgroundColor: "#e8e9ec",
      width: 1280,
      height: 860,
      minWidth: 1100,
      minHeight: 720,
      // Revealed on first paint below: no empty-window flash.
      show: false,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        preload: path.join(import.meta.dirname, "preload.cjs"),
        sandbox: true,
      },
    });
    // BOTH listeners: a window that never fires `ready-to-show` stays invisible.
    const reveal = (): void => {
      if (win.isDestroyed() || win.isVisible()) return;
      win.show();
    };
    win.once("ready-to-show", reveal);
    win.webContents.once("did-finish-load", reveal);
    void win.loadFile(path.join(import.meta.dirname, "renderer", "index.html"));
    win.webContents.setWindowOpenHandler(({ url }) => {
      if (canOpenExternal(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    win.webContents.on("console-message", (event) => {
      const level = (event as unknown as { level?: string }).level ?? "info";
      const message = (event as unknown as { message?: string }).message ?? "";
      process.stdout.write(`[RENDERER:${level}] ${message}\n`);
    });
  };

  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  });

  void app.whenReady().then(() => {
    installMediaProtocol(() => connection);
    registerIpcHandlers({
      seat: () => connection,
      ensureSeat: async () => {
        await supervisor.ensure();
        if (!connection) throw new Error("the seat is not attached");
        return connection;
      },
      failure: () => supervisor.failure(),
      retry: () => supervisor.retry(),
      lastState: () => lastState,
      dataDir,
    });
    // WINDOW FIRST: an error modal with no window behind it hangs an
    // unattended launch, and the seat's failure renders in-window.
    createWindow();
    void supervisor.ensure().catch((error: unknown) => {
      log(`[startup] the seat did not start: ${String(error)}`);
    });
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  // `before-quit` is cancelable, so the `quitting` latch passes the re-fire
  // through. The teardown cap is deliberately NOT unref'd: it must fire when
  // teardown wedges.
  const QUIT_TEARDOWN_TIMEOUT_MS = 8000;
  let quitting = false;
  app.on("before-quit", (event) => {
    if (quitting) return;
    quitting = true;
    event.preventDefault();
    let cap: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<void>((resolve) => {
      cap = setTimeout(resolve, QUIT_TEARDOWN_TIMEOUT_MS);
    });
    void Promise.race([
      supervisor.shutdown().then((steps) => {
        log(`[quit] ${steps.join(" → ")}`);
      }),
      timeout,
    ]).finally(() => {
      if (cap) clearTimeout(cap);
      app.quit();
    });
  });
} else {
  app.quit();
}
