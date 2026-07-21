/*
 * Relaunch-to-update — electron wiring around the pure core in
 * update-check.ts. Polls the built `dist/` on a slow unref'd timer; when a
 * new build settles on disk it broadcasts UPDATE_AVAILABLE to every window
 * so the sidebar can show the "Relaunch to update" pill. The pill's click
 * lands on `relaunchToUpdate()` (via IPC in ipc.ts), which restarts the
 * process with the same argv/cwd — the relaunched Electron loads the new
 * bundles.
 *
 * Issue #468 I4–I6: every announce path gates through {@link admitUpdate}
 * (pure staged-rollout math). Unpackaged dev still uses dist mtime detection;
 * packaged builds call {@link startPackagedUpdateChecker} which uses the same
 * admit gate once electron-updater reports a candidate.
 */

import { app, BrowserWindow } from 'electron';
import { createRequire } from 'node:module';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  fingerprintOf,
  UpdatePoller,
  WATCHED_DIST_FILES,
  type WatchedStat,
} from './update-check.js';
import { admitUpdate } from './update-rollout.js';

const POLL_MS = 10_000;

/**
 * Broadcast channel for "a new build is on disk". Mirrored (as a string
 * literal, like every other channel) in preload.ts; the invoke channels
 * live in ipc.ts's Channel table.
 */
export const UPDATE_AVAILABLE_CHANNEL = 'centraid:update:available';

export interface UpdateStatus {
  available: boolean;
  /** Version of the build on disk (package.json) — what a relaunch loads. */
  version: string;
}

let current: UpdateStatus | null = null;
let started = false;

/** Renderer-facing snapshot, for windows that mount after the broadcast. */
export function getUpdateStatus(): UpdateStatus {
  return current ?? { available: false, version: app.getVersion() };
}

/** Restart with the same argv/cwd; the new process loads the new dist. */
export function relaunchToUpdate(): void {
  app.relaunch();
  app.exit(0);
}

async function statWatched(distDir: string): Promise<Array<WatchedStat | null>> {
  return Promise.all(
    WATCHED_DIST_FILES.map(async (rel) => {
      try {
        const s = await stat(path.join(distDir, rel));
        return { mtimeMs: s.mtimeMs, size: s.size };
      } catch {
        return null;
      }
    }),
  );
}

/** The on-disk version a relaunch would load (falls back to the running one). */
async function readDiskVersion(appRoot: string): Promise<string> {
  try {
    const pkg = JSON.parse(await readFile(path.join(appRoot, 'package.json'), 'utf8')) as {
      version?: string;
    };
    return typeof pkg.version === 'string' ? pkg.version : app.getVersion();
  } catch {
    return app.getVersion();
  }
}

async function broadcastUpdate(status: UpdateStatus): Promise<void> {
  current = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(UPDATE_AVAILABLE_CHANNEL, current);
  }
}

/**
 * Announce an available update only when staged rollout admits this install
 * (I4 thin wiring over pure I5/I6 math). `manualCheck` always admits.
 * Exported for unit tests that drive the real admit path.
 */
export async function announceUpdateIfAdmitted(input: {
  version: string;
  /** Release publish time; omit → fail-open admit. */
  releasedAtMs?: number | null;
  manualCheck?: boolean;
}): Promise<boolean> {
  const admitted = await admitUpdate({
    releasedAtMs: input.releasedAtMs,
    manualCheck: input.manualCheck === true,
  });
  if (!admitted) return false;
  await broadcastUpdate({ available: true, version: input.version });
  return true;
}

/**
 * Start the dist watcher (unpackaged) or packaged updater. Idempotent.
 */
export function startUpdateWatcher(): void {
  if (started) return;
  started = true;
  if (app.isPackaged) {
    startPackagedUpdateChecker();
    return;
  }
  const appRoot = app.getAppPath();
  const distDir = path.join(appRoot, 'dist');

  void (async () => {
    const poller = new UpdatePoller(fingerprintOf(await statWatched(distDir)));
    const timer = setInterval(() => {
      void (async () => {
        const verdict = poller.tick(fingerprintOf(await statWatched(distDir)));
        if (verdict !== 'update-available') return;
        const stats = await statWatched(distDir);
        const releasedAtMs = Math.max(0, ...stats.map((s) => (s ? s.mtimeMs : 0)));
        const version = await readDiskVersion(appRoot);
        await announceUpdateIfAdmitted({ version, releasedAtMs });
      })();
    }, POLL_MS);
    timer.unref();
  })();
}

/**
 * Packaged-app update path (I4). Loads electron-updater when present; always
 * gates "update available" through admitUpdate. No-ops when the dependency
 * is not installed (unsigned scaffolding without enrolled secrets).
 */
export function startPackagedUpdateChecker(): void {
  void (async () => {
    try {
      const req = createRequire(import.meta.url);
      // Optional — release workflow installs electron-updater; not a hard dep.
      const { autoUpdater } = req('electron-updater') as {
        autoUpdater: {
          autoDownload: boolean;
          autoInstallOnAppQuit: boolean;
          checkForUpdates: () => Promise<unknown>;
          on: (event: string, cb: (info: unknown) => void) => void;
        };
      };
      // I9: never install-on-quit a stale download; re-check before install.
      autoUpdater.autoDownload = false;
      autoUpdater.autoInstallOnAppQuit = false;
      autoUpdater.on('update-available', (info: unknown) => {
        void (async () => {
          const release = info as { version?: string; releaseDate?: string };
          const version = typeof release.version === 'string' ? release.version : app.getVersion();
          const parsed =
            typeof release.releaseDate === 'string' ? Date.parse(release.releaseDate) : NaN;
          await announceUpdateIfAdmitted({
            version,
            releasedAtMs: Number.isFinite(parsed) ? parsed : null,
          });
        })();
      });
      await autoUpdater.checkForUpdates();
    } catch {
      // Packaged without updater lib — silent.
    }
  })();
}
