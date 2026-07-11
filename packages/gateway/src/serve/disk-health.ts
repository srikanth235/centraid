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
 */

import fs from 'node:fs';
import path from 'node:path';
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
    if (freeBytes < DISK_ERROR_BELOW_BYTES) return { status: 'error', detail };
    if (freeBytes < DISK_DEGRADED_BELOW_BYTES) return { status: 'degraded', detail };
    return { status: 'ok', detail };
  };
}
