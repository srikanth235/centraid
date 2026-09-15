/*
 * Electron wiring around update-check.ts. Unpackaged: poll dist mtime.
 * Packaged: download after {@link admitUpdate} (#501), then ready-to-install.
 * Broadcast UPDATE_AVAILABLE; `relaunchToUpdate()` restarts same argv/cwd.
 */

import { readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import { app, BrowserWindow } from "electron";

import {
  fingerprintOf,
  UpdatePoller,
  WATCHED_DIST_FILES,
} from "./update-check.js";
import type { WatchedStat } from "./update-check.js";
import { admitUpdate } from "./update-rollout.js";
import {
  admitDownloadedUpdate,
  artifactFromUpdateInfo,
} from "./update-signature-gate.js";

const POLL_MS = 10_000;
const PACKAGED_CHECK_MS = 4 * 60 * 60 * 1000;

export const UPDATE_AVAILABLE_CHANNEL = "centraid:update:available";

export interface UpdateStatus {
  available: boolean;
  version: string;
  /** Packaged: true only after download. Unpackaged: true when available. */
  readyToInstall?: boolean;
}

let current: UpdateStatus | null = null;
let started = false;
let packagedDownloadReady = false;
let autoUpdaterRef: {
  downloadUpdate: () => Promise<unknown>;
  quitAndInstall: (isSilent?: boolean, isForceRunAfter?: boolean) => void;
  checkForUpdates: () => Promise<unknown>;
  channel: string | null;
} | null = null;

export function getUpdateStatus(): UpdateStatus {
  return (
    current ?? {
      available: false,
      version: app.getVersion(),
      readyToInstall: false,
    }
  );
}

export function relaunchToUpdate(): void {
  if (app.isPackaged && packagedDownloadReady && autoUpdaterRef) {
    // I9: admitted download; forceRunAfter so the app returns.
    autoUpdaterRef.quitAndInstall(false, true);
    return;
  }
  app.relaunch();
  app.exit(0);
}

async function statWatched(
  distDir: string
): Promise<Array<WatchedStat | null>> {
  return Promise.all(
    WATCHED_DIST_FILES.map(async (rel) => {
      try {
        const s = await stat(path.join(distDir, rel));
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    })
  );
}

async function readDiskVersion(appRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(
      await readFile(path.join(appRoot, "package.json"), "utf8")
    ) as {
      version?: string;
    };
    return typeof pkg.version === "string" ? pkg.version : app.getVersion();
  } catch {
    return app.getVersion();
  }
}

async function broadcastUpdate(status: UpdateStatus): Promise<void> {
  current = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      win.webContents.send(UPDATE_AVAILABLE_CHANNEL, current);
  }
}

export async function announceUpdateIfAdmitted(input: {
  version: string;
  releasedAtMs?: number | null;
  manualCheck?: boolean;
  readyToInstall?: boolean;
}): Promise<boolean> {
  const admitted = await admitUpdate({
    releasedAtMs: input.releasedAtMs,
    manualCheck: input.manualCheck === true,
  });
  if (!admitted) return false;
  await broadcastUpdate({
    available: true,
    version: input.version,
    readyToInstall: input.readyToInstall !== false,
  });
  return true;
}

export function updaterChannelForVersion(version: string): "beta" | "latest" {
  return /beta/iu.test(version) ? "beta" : "latest";
}

export function startUpdateWatcher(): void {
  if (started) return;
  started = true;
  if (app.isPackaged) {
    startPackagedUpdateChecker();
    return;
  }
  const appRoot = app.getAppPath();
  const distDir = path.join(appRoot, "dist");

  void (async () => {
    const poller = new UpdatePoller(fingerprintOf(await statWatched(distDir)));
    const timer = setInterval(() => {
      void (async () => {
        const verdict = poller.tick(fingerprintOf(await statWatched(distDir)));
        if (verdict !== "update-available") return;
        const stats = await statWatched(distDir);
        const releasedAtMs = Math.max(
          0,
          ...stats.map((s) => (s ? s.mtimeMs : 0))
        );
        const version = await readDiskVersion(appRoot);
        await announceUpdateIfAdmitted({
          version,
          releasedAtMs,
          readyToInstall: true,
        });
      })();
    }, POLL_MS);
    timer.unref();
  })();
}

/**
 * Packaged path (I4 / #501). createRequire here — CJS `autoUpdater` crashes
 * under `"type":"module"` if imported statically. Download after admit;
 * never call the autoUpdater getter outside this packaged-ready path.
 */
export function startPackagedUpdateChecker(): void {
  void (async () => {
    try {
      // Deferred CJS load; knip cannot see createRequire (knip.json ignoreDependencies).
      const req = createRequire(import.meta.url);
      const { autoUpdater } = req("electron-updater") as {
        autoUpdater: {
          autoDownload: boolean;
          autoInstallOnAppQuit: boolean;
          channel: string | null;
          allowPrerelease: boolean;
          checkForUpdates: () => Promise<unknown>;
          downloadUpdate: () => Promise<unknown>;
          quitAndInstall: (
            isSilent?: boolean,
            isForceRunAfter?: boolean
          ) => void;
          on: (event: string, cb: (info: unknown) => void) => void;
        };
      };
      // I9: never install-on-quit a stale download.
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.channel = updaterChannelForVersion(app.getVersion());
      autoUpdater.allowPrerelease = autoUpdater.channel === "beta";
      autoUpdaterRef = autoUpdater;

      autoUpdater.on("update-available", (info: unknown) => {
        void (async () => {
          const release = info as { version?: string; releaseDate?: string };
          const version =
            typeof release.version === "string"
              ? release.version
              : app.getVersion();
          const parsed =
            typeof release.releaseDate === "string"
              ? Date.parse(release.releaseDate)
              : NaN;
          const releasedAtMs = Number.isFinite(parsed) ? parsed : null;
          const admitted = await admitUpdate({
            releasedAtMs,
            manualCheck: false,
          });
          if (!admitted) return;
          await broadcastUpdate({
            available: true,
            version,
            readyToInstall: false,
          });
          try {
            await autoUpdater.downloadUpdate();
          } catch {
            // Network failure — leave available, not ready; user can retry.
          }
        })();
      });

      autoUpdater.on("update-downloaded", (info: unknown) => {
        void (async () => {
          const release = info as { version?: string; releaseDate?: string };
          const version =
            typeof release.version === "string"
              ? release.version
              : app.getVersion();
          // W6.1 (#842): installable only with a pinned-key signature. Refusal
          // leaves packagedDownloadReady false — relaunch, never quitAndInstall.
          const trusted = await admitDownloadedUpdate({
            packaged: app.isPackaged,
            version,
            artifact: artifactFromUpdateInfo(info),
            fetchText: (url) => fetch(url),
          });
          if (!trusted) return;
          packagedDownloadReady = true;
          const parsed =
            typeof release.releaseDate === "string"
              ? Date.parse(release.releaseDate)
              : NaN;
          await announceUpdateIfAdmitted({
            version,
            releasedAtMs: Number.isFinite(parsed) ? parsed : null,
            readyToInstall: true,
          });
        })();
      });

      await autoUpdater.checkForUpdates();
      const timer = setInterval(() => {
        void autoUpdater.checkForUpdates().catch(() => {
          /* ignore */
        });
      }, PACKAGED_CHECK_MS);
      timer.unref();
    } catch {
      // Packaged without updater lib / no feed / offline.
    }
  })();
}

export async function checkForUpdatesManual(): Promise<UpdateStatus> {
  if (!app.isPackaged || !autoUpdaterRef) {
    return getUpdateStatus();
  }
  try {
    await autoUpdaterRef.checkForUpdates();
  } catch {
    /* ignore */
  }
  return getUpdateStatus();
}
