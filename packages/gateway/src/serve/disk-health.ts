/*
 * Disk watermark — the `disk` health component (issue #351 tier 3).
 *
 * A gateway that runs out of free space on the vault volume fails writes
 * (SQLite WAL checkpoints, blob CAS, backups) with confusing downstream
 * errors; this probes free space directly so the operator sees "the disk
 * is nearly full" instead of a SQLITE_FULL stack trace three layers down.
 *
 * `statfs`/`fileSize` are injectable so tests can exercise the thresholds
 * without needing an actual near-full filesystem.
 *
 * Disk-full (issue #351 wave 4): a `statfs` snapshot alone can miss a real
 * write failure — a per-volume quota, or a few bytes freed up between the
 * ENOSPC and the next health tick — so every write path (vault SQLite
 * writes, blob CAS, gateway log persistence) reports into
 * `sharedDiskFullTracker` on an ENOSPC/SQLITE_FULL error. This probe reads
 * that tracker: a recorded event forces `error` (with an "ENOSPC observed
 * at <time> in <context>" detail) for at least the one tick right after it
 * fires, even if that tick's statfs reading already looks recovered; the
 * event then clears so the FOLLOWING tick reflects statfs normally.
 */

import fs from 'node:fs';
import path from 'node:path';
import { sharedDiskFullTracker, type DiskFullTracker } from '@centraid/vault';
import type { HealthProbe } from './health-registry.js';

/** Free space below this ⇒ `error` — writes are about to start failing. */
export const DISK_ERROR_BELOW_BYTES = 1 * 1024 ** 3; // 1 GiB

/** Free space below this ⇒ `degraded` — still writable, getting close. */
export const DISK_DEGRADED_BELOW_BYTES = 5 * 1024 ** 3; // 5 GiB

/** The subset of `fs.statfsSync`'s result this probe needs. */
export interface StatfsResult {
  bavail: number;
  bsize: number;
  blocks: number;
}

export interface VaultDiskEntry {
  vaultId: string;
  /** The vault's directory (holds `vault.db` + `journal.db`). */
  dir: string;
}

export interface DiskHealthOptions {
  /** Root directory to statfs (the vault registry's `rootDir`). */
  rootDir: string;
  /** Mounted vaults to report per-vault DB size for. */
  vaults: () => VaultDiskEntry[];
  /** Injectable for tests — defaults to `fs.statfsSync`. */
  statfs?: (dir: string) => StatfsResult;
  /**
   * Injectable for tests — defaults to `fs.statSync(file).size`, 0 when the
   * file doesn't exist (a vault with no WAL file yet is not an error).
   */
  fileSize?: (file: string) => number;
  /**
   * The last-ENOSPC record every write path (vault SQLite writes, blob CAS,
   * gateway log persistence) reports into. Defaults to the process-wide
   * `sharedDiskFullTracker` so this wires up with no caller changes — tests
   * inject their own `new DiskFullTracker()` for isolation.
   */
  diskFullTracker?: DiskFullTracker;
}

const defaultFileSize = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/** `vault.db` + `journal.db` and their `-wal` siblings — cheap `statSync`s, never the blob CAS. */
function vaultDbBytes(dir: string, fileSize: (file: string) => number): number {
  const files = ['vault.db', 'vault.db-wal', 'journal.db', 'journal.db-wal'];
  return files.reduce((sum, name) => sum + fileSize(path.join(dir, name)), 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/** Builds the `disk` component's `HealthProbe` (registered in `build-gateway.ts`). */
export function createDiskHealthProbe(options: DiskHealthOptions): HealthProbe {
  const statfs = options.statfs ?? ((dir: string) => fs.statfsSync(dir));
  const fileSize = options.fileSize ?? defaultFileSize;
  const diskFullTracker = options.diskFullTracker ?? sharedDiskFullTracker;
  return async () => {
    const stat = statfs(options.rootDir);
    const freeBytes = stat.bavail * stat.bsize;
    const totalBytes = stat.blocks * stat.bsize;
    const perVault = options
      .vaults()
      .map(
        ({ vaultId, dir }) => `${vaultId.slice(0, 8)}: ${formatBytes(vaultDbBytes(dir, fileSize))}`,
      )
      .join(', ');
    const detail =
      `${formatBytes(freeBytes)} free of ${formatBytes(totalBytes)}` +
      (perVault.length > 0 ? ` — ${perVault}` : '');

    // A prior ENOSPC/SQLITE_FULL write failure forces `error` — even on a
    // tick where statfs reports plenty free (a write can fail on a volume
    // quota, or space can free up again microseconds after the failure) —
    // for at least the one tick right after the event, so an operator
    // never sees a health page that silently skipped straight from "a write
    // just failed" to "ok" with no trace. A reading back ABOVE the error
    // watermark clears the event for the FOLLOWING tick.
    const diskFull = diskFullTracker.current();
    if (freeBytes >= DISK_ERROR_BELOW_BYTES) diskFullTracker.clear();
    if (freeBytes < DISK_ERROR_BELOW_BYTES) return { status: 'error', detail };
    if (diskFull) {
      return {
        status: 'error',
        detail: `${detail} — ENOSPC observed at ${diskFull.at} in ${diskFull.context}`,
      };
    }
    if (freeBytes < DISK_DEGRADED_BELOW_BYTES) return { status: 'degraded', detail };
    return { status: 'ok', detail };
  };
}
