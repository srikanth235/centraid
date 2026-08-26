import { DEFAULT_BACKUP_POLICY } from "@centraid/vault";
import type { BackupPolicy } from "@centraid/vault";

import type { BackupState } from "./backup-state.js";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function evaluateBackupHealth(opts: {
  state: BackupState;
  policyForVault?: (vaultId: string) => BackupPolicy;
  now: number;
}): { status: "ok" | "degraded" | "error"; detail?: string } {
  const rows = Object.entries(opts.state.targets);
  if (rows.length === 0)
    return { status: "ok", detail: "no vaults backed up yet" };
  let worst: "ok" | "degraded" | "error" = "ok";
  const notes: string[] = [];
  for (const [vaultId, target] of rows) {
    const policy = opts.policyForVault?.(vaultId) ?? DEFAULT_BACKUP_POLICY;
    const staleBackupMs = policy.snapshotIntervalHours * HOUR_MS * 2;
    const staleVerifyMs = policy.verifyEveryDays * DAY_MS * 2;
    const providerPolicy = target.providerPolicy;
    if (
      providerPolicy?.status === "rejected" ||
      providerPolicy?.status === "error"
    ) {
      worst = "error";
      notes.push(
        `${vaultId}: provider policy ${providerPolicy.status}` +
          (providerPolicy.error ? ` — ${providerPolicy.error}` : "")
      );
    } else if (providerPolicy?.status === "drift") {
      if (worst !== "error") worst = "degraded";
      notes.push(
        `${vaultId}: provider policy echo differs from the vault policy`
      );
    } else if (
      providerPolicy?.status === "unsupported" ||
      providerPolicy?.status === "pending"
    ) {
      if (worst !== "error") worst = "degraded";
      notes.push(`${vaultId}: provider policy is ${providerPolicy.status}`);
    }
    const reconciliation = target.reconciliation;
    if (reconciliation?.status === "error") {
      worst = "error";
      notes.push(
        `${vaultId}: inventory drift — ${reconciliation.cas.missing.count} CAS missing, ` +
          `${reconciliation.backup.missing.count} backup missing, ` +
          `${reconciliation.walGaps.count} WAL gap(s)`
      );
    } else if (reconciliation?.status === "degraded") {
      if (worst !== "error") worst = "degraded";
      notes.push(
        `${vaultId}: inventory warning — ` +
          `${reconciliation.cas.orphans.count + reconciliation.backup.orphans.count} orphan(s)`
      );
    }
    if (
      reconciliation &&
      opts.now - Date.parse(reconciliation.checkedAt) >= staleVerifyMs
    ) {
      if (worst !== "error") worst = "degraded";
      notes.push(`${vaultId}: inventory reconciliation is stale`);
    }
    if (target.fenced) {
      worst = "error";
      notes.push(
        `${vaultId}: fenced — another machine has taken over this vault`
      );
      continue;
    }
    if (target.lastError || target.lastVerifyError) {
      worst = "error";
      notes.push(`${vaultId}: ${target.lastVerifyError ?? target.lastError}`);
      continue;
    }
    // A confirmed WAL drain OR a newer full snapshot satisfies the
    // recovery-point bound; an old WAL stamp must not repaint a fresh one.
    const walBaselineMs = Math.max(
      ...[target.lastWalDrainAt, target.lastBackupAt, target.firstBackupAt]
        .filter((value): value is string => value !== undefined)
        .map((value) => Date.parse(value))
    );
    const walAgeMs = Number.isFinite(walBaselineMs)
      ? opts.now - walBaselineMs
      : Number.POSITIVE_INFINITY;
    if (walAgeMs >= policy.rpoSeconds * 2 * 1000) {
      worst = "error";
      notes.push(
        `${vaultId}: WAL replication exceeded 2× the ${policy.rpoSeconds}s RPO`
      );
    }
    const backupAgeMs = target.lastBackupAt
      ? opts.now - Date.parse(target.lastBackupAt)
      : Number.POSITIVE_INFINITY;
    if (backupAgeMs >= staleBackupMs) {
      worst = "error";
      notes.push(`${vaultId}: backups are stale`);
      continue;
    }
    const verifyBaseline = target.lastVerifiedAt ?? target.lastBackupAt;
    const verifyAgeMs = verifyBaseline
      ? opts.now - Date.parse(verifyBaseline)
      : Number.POSITIVE_INFINITY;
    if (verifyAgeMs >= staleVerifyMs) {
      if (worst !== "error") worst = "degraded";
      notes.push(`${vaultId}: verification is stale`);
    }
    // Issue #408 G9: a FAILED restore-verification is persisted state until
    // the next success — alarms at ERROR immediately, not on staleness.
    if (target.lastRestoreVerifyError) {
      worst = "error";
      notes.push(
        `${vaultId}: restore-verification failed: ${target.lastRestoreVerifyError}`
      );
      continue;
    }
    // Issue #408 G8: dangling receipts are persisted state (legitimate after
    // hard-deleted rows, evidence of a capture bug otherwise), not a pushed
    // report the next probe would overwrite.
    const dangling = target.lastRestoreVerifyDangling ?? 0;
    if (dangling > 0) {
      if (worst !== "error") worst = "degraded";
      notes.push(
        `${vaultId}: last restore-verification found ${dangling} receipt(s) referencing absent vault rows`
      );
    }
    // Issue #411 action 1: a FOREIGN checkpoint (stray connection with
    // `wal_autocheckpoint` unset) forces a generation break; verification
    // caught and re-based it, so DEGRADED not error. Persisted so the probe
    // recomputes it, aged out after 24h only if the foreign checkpoint stopped.
    const lastForeign = target.walLastForeignCheckpoint;
    if (lastForeign && opts.now - lastForeign.atMs < DAY_MS) {
      if (worst !== "error") worst = "degraded";
      notes.push(
        `${vaultId}: ${target.walForeignCheckpointCount ?? 1} foreign checkpoint(s) detected ` +
          `(last: ${lastForeign.db} — ${lastForeign.reason}) — something else is checkpointing ` +
          `this vault's databases`
      );
    }
    // Issue #408 G9: a never-restored backup is a hypothesis — restore
    // staleness alarms at ERROR; first-backup baseline gives fresh targets grace.
    const restoreBaseline =
      target.lastRestoreVerifiedAt ??
      target.firstBackupAt ??
      target.lastBackupAt;
    const restoreAgeMs = restoreBaseline
      ? opts.now - Date.parse(restoreBaseline)
      : Number.POSITIVE_INFINITY;
    if (restoreAgeMs >= 14 * DAY_MS) {
      worst = "error";
      notes.push(
        `${vaultId}: no successful restore-verification within 14 days`
      );
    }
  }
  return {
    status: worst,
    detail:
      notes.length > 0 ? notes.join("; ") : `${rows.length} vault(s) backed up`,
  };
}
