import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { pruneExpiredEntityRevisions } from "./commands/entity-revisions.js";
import type { EntityRevisionPruneResult } from "./commands/entity-revisions.js";
import { RETENTION_ROW_CAP, sweepBoundedRetention } from "./retention.js";
import type { RetentionSweepResult } from "./retention.js";

export const VAULT_RETENTION_LADDER: readonly number[] = Object.freeze([
  90, 30, 14, 7,
]);

export const VAULT_RETENTION_DEFAULT_KEEP_DAYS =
  VAULT_RETENTION_LADDER[0] as number;

export const VAULT_RETENTION_FLOOR_KEEP_DAYS = VAULT_RETENTION_LADDER[
  VAULT_RETENTION_LADDER.length - 1
] as number;

export interface VaultMaintenanceDecisionInput {
  vaultBytes: number;
  limitBytes: number | null;
  rung: number;
  dailyGateElapsed: boolean;
}

export interface VaultMaintenanceDecision {
  run: boolean;
  keepDays: number;
  nextRung: number;
  overLimit: boolean;
  atFloor: boolean;
}

export function decideVaultMaintenance(
  input: VaultMaintenanceDecisionInput
): VaultMaintenanceDecision {
  const { vaultBytes, limitBytes, dailyGateElapsed } = input;
  const overLimit =
    limitBytes !== null && limitBytes > 0 && vaultBytes > limitBytes;

  if (!overLimit) {
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
  capped: boolean;
}

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
