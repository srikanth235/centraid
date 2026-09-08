/*
 * The `disk` health component (#351, #521). Status trips on PERCENT FREE **or**
 * an ABSOLUTE FLOOR — absolute-only calls a 32 GiB card with 4 GiB free
 * degraded. statfs alone misses a quota, so a `sharedDiskFullTracker` event
 * forces `error` for the tick after it fires.
 */

import fs from "node:fs";
import path from "node:path";

import { sharedDiskFullTracker } from "@centraid/vault";
import type { DiskFullTracker } from "@centraid/vault";

import type { ComponentStatus, HealthProbe } from "./health-registry.js";

export const DISK_ERROR_BELOW_BYTES = 512 * 1024 ** 2;

export const DISK_DEGRADED_BELOW_BYTES = 2 * 1024 ** 3;

export const DISK_ERROR_BELOW_PERCENT = 5;

export const DISK_DEGRADED_BELOW_PERCENT = 15;

export interface StatfsResult {
  bavail: number;
  bsize: number;
  blocks: number;
}

export interface VaultDiskEntry {
  vaultId: string;
  dir: string;
}

export interface DiskHealthOptions {
  rootDir: string;
  vaults: () => VaultDiskEntry[];
  statfs?: (dir: string) => StatfsResult;
  /** 0 for a missing file — no WAL yet is not an error. */
  fileSize?: (file: string) => number;
  /** Defaults to `sharedDiskFullTracker`. */
  diskFullTracker?: DiskFullTracker;
}

export interface DiskFreeEvaluation {
  status: ComponentStatus;
  freeBytes: number;
  totalBytes: number;
  freePercent: number;
}

/** Pure, so tests drive the shipped thresholds. */
export function evaluateDiskFreeStatus(
  freeBytes: number,
  totalBytes: number
): DiskFreeEvaluation {
  const safeTotal = totalBytes > 0 ? totalBytes : 0;
  const safeFree = Math.max(0, freeBytes);
  const freePercent = safeTotal > 0 ? (safeFree / safeTotal) * 100 : 0;

  let status: ComponentStatus = "ok";
  if (
    safeFree < DISK_ERROR_BELOW_BYTES ||
    freePercent < DISK_ERROR_BELOW_PERCENT
  ) {
    status = "error";
  } else if (
    safeFree < DISK_DEGRADED_BELOW_BYTES ||
    freePercent < DISK_DEGRADED_BELOW_PERCENT
  ) {
    status = "degraded";
  }

  return { status, freeBytes: safeFree, totalBytes: safeTotal, freePercent };
}

const defaultFileSize = (file: string): number => {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
};

/** The DB files only, never the blob CAS. */
function vaultDbBytes(dir: string, fileSize: (file: string) => number): number {
  const files = ["vault.db", "vault.db-wal"];
  return files.reduce((sum, name) => sum + fileSize(path.join(dir, name)), 0);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export function createDiskHealthProbe(options: DiskHealthOptions): HealthProbe {
  const statfs = options.statfs ?? ((dir: string) => fs.statfsSync(dir));
  const fileSize = options.fileSize ?? defaultFileSize;
  const diskFullTracker = options.diskFullTracker ?? sharedDiskFullTracker;
  return async () => {
    const stat = statfs(options.rootDir);
    const freeBytes = stat.bavail * stat.bsize;
    const totalBytes = stat.blocks * stat.bsize;
    const evaluation = evaluateDiskFreeStatus(freeBytes, totalBytes);
    const perVault = options
      .vaults()
      .map(
        ({ vaultId, dir }) =>
          `${vaultId.slice(0, 8)}: ${formatBytes(vaultDbBytes(dir, fileSize))}`
      )
      .join(", ");
    const detail =
      `${formatBytes(evaluation.freeBytes)} free of ${formatBytes(evaluation.totalBytes)}` +
      ` (${evaluation.freePercent.toFixed(1)}% free)` +
      (perVault.length > 0 ? ` — ${perVault}` : "");

    // Clear only above the absolute error floor: a tiny recovered pocket must
    // not hide a prior ENOSPC.
    const diskFull = diskFullTracker.current();
    if (evaluation.freeBytes >= DISK_ERROR_BELOW_BYTES) diskFullTracker.clear();
    if (evaluation.status === "error") return { status: "error", detail };
    if (diskFull) {
      return {
        status: "error",
        detail: `${detail} — ENOSPC observed at ${diskFull.at} in ${diskFull.context}`,
      };
    }
    if (evaluation.status === "degraded") return { status: "degraded", detail };
    return { status: "ok", detail };
  };
}
