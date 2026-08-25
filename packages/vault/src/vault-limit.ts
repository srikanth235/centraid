/*
 * The size ladder for `vault.db` (#659) — the same shape
 * `journal-limit.ts` gives `journal.db`, for the file that had no ladder at
 * all.
 *
 * Why this exists. `journal.db` has had a size policy since #544: measure the
 * file, and when it is over the owner's limit, bypass the daily gate and
 * narrow the archival window one rung at a time. `vault.db` had neither a
 * measurement nor a policy — its growth was invisible until a backup got
 * slow. It now has both: this module measures the file, decides whether the
 * bounded retention passes should run early and how narrow their window
 * should be, and `runVaultMaintenance` is the single hookpoint a host sweep
 * calls.
 *
 * What "maintenance" may do is deliberately narrow. Nothing here touches an
 * owner-authored row. It is exactly the two garbage collectors:
 * `pruneExpiredEntityRevisions` (snapshots past their undo window, which the
 * store's own reader already refuses) and `sweepBoundedRetention` (terminal
 * connector runs, drained enrichment requests, decided outbox items). A
 * narrower rung shortens the grace on those, never the reach of anything into
 * live data — which is why the ladder can be aggressive without being
 * dangerous, and why the floor is a floor rather than "delete everything".
 *
 * The ladder position is a per-host, in-memory value, deliberately not
 * persisted: a restart re-derives it from the file size on the next sweep,
 * the only input that matters.
 */

import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { pruneExpiredEntityRevisions } from "./commands/entity-revisions.js";
import type { EntityRevisionPruneResult } from "./commands/entity-revisions.js";
import { RETENTION_ROW_CAP, sweepBoundedRetention } from "./retention.js";
import type { RetentionSweepResult } from "./retention.js";

/** Retention windows, widest first. The last rung is the floor. */
export const VAULT_RETENTION_LADDER: readonly number[] = Object.freeze([
  90, 30, 14, 7,
]);

/** The widest rung — an unset limit reproduces the default retention window. */
export const VAULT_RETENTION_DEFAULT_KEEP_DAYS =
  VAULT_RETENTION_LADDER[0] as number;

/** The narrowest rung — retention never reaches inside this many days. */
export const VAULT_RETENTION_FLOOR_KEEP_DAYS = VAULT_RETENTION_LADDER[
  VAULT_RETENTION_LADDER.length - 1
] as number;

export interface VaultMaintenanceDecisionInput {
  /** Current `vault.db` (+ `-wal`) size in bytes. */
  vaultBytes: number;
  /** The owner's limit, or `null` when they haven't set one. */
  limitBytes: number | null;
  /** Ladder index carried from the previous sweep (0 = widest window). */
  rung: number;
  /** `true` when the host's own once-a-day gate has elapsed. */
  dailyGateElapsed: boolean;
}

export interface VaultMaintenanceDecision {
  /** Whether to run the bounded retention passes on this sweep at all. */
  run: boolean;
  /** Grace window to pass to the retention passes. */
  keepDays: number;
  /** Ladder index to carry into the next sweep. */
  nextRung: number;
  /** `true` when the size limit — not the daily gate — is why this runs. */
  overLimit: boolean;
  /** `true` when the file is still over the limit at the narrowest rung. */
  atFloor: boolean;
}

/**
 * The whole policy in one pure function. With no limit set it collapses to
 * "run on the daily gate at the 90-day window", which is the behaviour a
 * vault that never grows past its limit sees forever.
 */
export function decideVaultMaintenance(
  input: VaultMaintenanceDecisionInput
): VaultMaintenanceDecision {
  const { vaultBytes, limitBytes, dailyGateElapsed } = input;
  const overLimit =
    limitBytes !== null && limitBytes > 0 && vaultBytes > limitBytes;

  if (!overLimit) {
    // Back under (or never over): relax to the widest window so the next
    // over-limit episode starts from the top rather than inheriting a narrow
    // window from an old one.
    return {
      run: dailyGateElapsed,
      keepDays: VAULT_RETENTION_DEFAULT_KEEP_DAYS,
      nextRung: 0,
      overLimit: false,
      atFloor: false,
    };
  }

  const lastRung = VAULT_RETENTION_LADDER.length - 1;
  const rung = Math.min(Math.max(0, input.rung), lastRung);
  const keepDays = VAULT_RETENTION_LADDER[rung] as number;
  return {
    run: true,
    keepDays,
    nextRung: Math.min(rung + 1, lastRung),
    overLimit: true,
    atFloor: keepDays === VAULT_RETENTION_FLOOR_KEEP_DAYS,
  };
}

/**
 * `vault.db` + its `-wal` on disk, in bytes. The WAL counts: those pages are
 * the file's real occupancy until a checkpoint folds them in. A missing file
 * counts zero, so an unmeasurable vault (a memory-backed test handle) reads
 * as "under any limit" rather than triggering maintenance on a guess.
 */
export function vaultFileBytes(dir: string, fileName = "vault.db"): number {
  let total = 0;
  for (const name of [fileName, `${fileName}-wal`]) {
    const full = path.join(dir, name);
    if (existsSync(full)) total += statSync(full).size;
  }
  return total;
}

export interface VaultMaintenanceResult {
  keepDays: number;
  revisions: EntityRevisionPruneResult;
  retention: RetentionSweepResult;
  /** `true` when any pass hit its cap — the host should sweep again sooner. */
  capped: boolean;
}

/**
 * The sweep hookpoint: run every bounded vault-side garbage collector once,
 * at the window the ladder chose. Callers own the cadence and the ladder
 * position; this function owns what a single pass is allowed to touch.
 */
export function runVaultMaintenance(
  vault: DatabaseSync,
  options: { now: string; keepDays?: number; limit?: number }
): VaultMaintenanceResult {
  const keepDays = options.keepDays ?? VAULT_RETENTION_DEFAULT_KEEP_DAYS;
  const limit = options.limit ?? RETENTION_ROW_CAP;
  const revisions = pruneExpiredEntityRevisions(vault, options.now, { limit });
  const retention = sweepBoundedRetention(vault, {
    now: options.now,
    keepDays,
    limit,
  });
  const capped =
    revisions.capped || Object.values(retention).some((table) => table.capped);
  return { keepDays, revisions, retention, capped };
}
