/*
 * Relaunch-to-update — electron wiring around the pure core in
 * update-check.ts. Polls the built `dist/` on a slow unref'd timer; when a
 * new build settles on disk it broadcasts UPDATE_AVAILABLE to every window
 * so the sidebar can show the "Relaunch to update" pill. The pill's click
 * lands on `relaunchToUpdate()` (via IPC in ipc.ts), which restarts the
 * process with the same argv/cwd — the relaunched Electron loads the new
 * bundles.
 */

import { app, BrowserWindow } from 'electron';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  fingerprintOf,
  UpdatePoller,
  WATCHED_DIST_FILES,
  type WatchedStat,
} from './update-check.js';

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

/**
 * Start the dist watcher. Idempotent; call once after app ready. Polling
 * (not fs.watch) keeps it robust against the multi-step build rewriting
 * the tree, and the interval is unref'd so it never holds the app open.
 */
export function startUpdateWatcher(): void {
  if (started) return;
  started = true;
  const appRoot = app.getAppPath();
  const distDir = path.join(appRoot, 'dist');

  void (async () => {
    const poller = new UpdatePoller(fingerprintOf(await statWatched(distDir)));
    const timer = setInterval(() => {
      void (async () => {
        const verdict = poller.tick(fingerprintOf(await statWatched(distDir)));
        if (verdict !== 'update-available') return;
        current = { available: true, version: await readDiskVersion(appRoot) };
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(UPDATE_AVAILABLE_CHANNEL, current);
        }
      })();
    }, POLL_MS);
    timer.unref();
  })();
}
