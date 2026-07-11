/*
 * Relaunch-to-update — pure detection core.
 *
 * The desktop runs unpackaged (`electron .` over the built `dist/`), so
 * "an update" means a newer build landed on disk while the app is running
 * (a `bun run build` in a checkout, or a pulled release artifact). The
 * running Electron process keeps executing the code it loaded at launch;
 * picking the new build up is a relaunch, exactly like Claude Code's
 * "Relaunch to update" pill. Packaged builds will swap this detection for
 * electron-updater later — the renderer surface (status + relaunch IPC)
 * stays the same.
 *
 * Detection: stat a fixed set of build outputs (one per build step, so any
 * of tsc / preload-bundle / assets / vite touching dist flips the print),
 * fingerprint mtime+size, and compare against the launch baseline. A build
 * writes files over several seconds, so a changed fingerprint only counts
 * once it repeats on two consecutive polls (the build settled). This module
 * is electron-free so it unit-tests as plain logic; the wiring (timers,
 * fs, IPC broadcast) lives in update-watcher.ts.
 */

/** Build outputs watched for change, relative to `dist/`. One per build step. */
export const WATCHED_DIST_FILES = [
  'main.js', // build:ts
  'preload.cjs', // build:preload
  'renderer/index.html', // build:assets
  'renderer/styles.css', // build:assets
  'renderer/react-boot.js', // build:react (vite entry — rewritten every build)
] as const;

/** The stat slice a fingerprint is built from; `null` = file missing. */
export interface WatchedStat {
  mtimeMs: number;
  size: number;
}

/** Order-sensitive print of the watched set — index i is WATCHED_DIST_FILES[i]. */
export function fingerprintOf(stats: ReadonlyArray<WatchedStat | null>): string {
  return stats.map((s) => (s ? `${s.mtimeMs}:${s.size}` : 'absent')).join('|');
}

export type PollVerdict =
  /** Nothing new — matches the baseline, or the update was already announced. */
  | 'unchanged'
  /** Differs from the last poll — a build is (probably) still writing. */
  | 'settling'
  /** A new build settled: announce it (fires exactly once). */
  | 'update-available';

/**
 * Debounced change detector over successive fingerprints. Feed it one
 * fingerprint per poll tick; it answers `update-available` exactly once,
 * when a print that differs from the launch baseline has held steady for
 * two consecutive ticks. Later rebuilds after that keep `available` true
 * without re-announcing — the pill is already showing.
 */
export class UpdatePoller {
  private readonly baseline: string;
  private prev: string;
  private announced = false;

  constructor(baseline: string) {
    this.baseline = baseline;
    this.prev = baseline;
  }

  get available(): boolean {
    return this.announced;
  }

  tick(fingerprint: string): PollVerdict {
    const settled = fingerprint === this.prev;
    this.prev = fingerprint;
    if (fingerprint === this.baseline) return 'unchanged';
    if (!settled) return 'settling';
    if (this.announced) return 'unchanged';
    this.announced = true;
    return 'update-available';
  }
}
