import {
  DEFAULT_INTERVAL_HOURS,
  DEFAULT_VERIFY_EVERY_DAYS,
  intervalHoursOf,
  verifyEveryDaysOf,
  type BackupConfig,
} from './backup-config.js';
import type { BackupState } from './backup-state.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

export function evaluateBackupHealth(opts: {
  state: BackupState;
  config?: BackupConfig;
  now: number;
}): { status: 'ok' | 'degraded' | 'error'; detail?: string } {
  const rows = Object.entries(opts.state.targets);
  if (rows.length === 0) return { status: 'ok', detail: 'no vaults backed up yet' };
  const staleBackupMs =
    (opts.config ? intervalHoursOf(opts.config) : DEFAULT_INTERVAL_HOURS) * HOUR_MS * 2;
  const staleVerifyMs =
    (opts.config ? verifyEveryDaysOf(opts.config) : DEFAULT_VERIFY_EVERY_DAYS) * DAY_MS * 2;
  let worst: 'ok' | 'degraded' | 'error' = 'ok';
  const notes: string[] = [];
  for (const [vaultId, target] of rows) {
    if (target.fenced) {
      worst = 'error';
      notes.push(`${vaultId}: fenced — another machine has taken over this vault`);
      continue;
    }
    if (target.lastError || target.lastVerifyError) {
      worst = 'error';
      notes.push(`${vaultId}: ${target.lastVerifyError ?? target.lastError}`);
      continue;
    }
    const backupAgeMs = target.lastBackupAt
      ? opts.now - Date.parse(target.lastBackupAt)
      : Number.POSITIVE_INFINITY;
    if (backupAgeMs >= staleBackupMs) {
      worst = 'error';
      notes.push(`${vaultId}: backups are stale`);
      continue;
    }
    const verifyBaseline = target.lastVerifiedAt ?? target.lastBackupAt;
    const verifyAgeMs = verifyBaseline
      ? opts.now - Date.parse(verifyBaseline)
      : Number.POSITIVE_INFINITY;
    if (verifyAgeMs >= staleVerifyMs) {
      if (worst !== 'error') worst = 'degraded';
      notes.push(`${vaultId}: verification is stale`);
    }
    // Issue #408 G9: a FAILED restore-verification (damaged wal object,
    // integrity failure) is persisted state until the next success — real
    // evidence the backup does not restore cleanly, so it alarms at ERROR
    // immediately, not after the staleness window below.
    if (target.lastRestoreVerifyError) {
      worst = 'error';
      notes.push(`${vaultId}: restore-verification failed: ${target.lastRestoreVerifyError}`);
      continue;
    }
    // Issue #408 G8: the last restore-verification SUCCEEDED but found
    // receipts naming vault rows the restored vault does not have. Legitimate
    // when the rows were hard-deleted after their receipt; evidence of a
    // capture-ordering bug otherwise — so it survives here, in persisted
    // state, rather than in a pushed report the next probe would overwrite.
    const dangling = target.lastRestoreVerifyDangling ?? 0;
    if (dangling > 0) {
      if (worst !== 'error') worst = 'degraded';
      notes.push(
        `${vaultId}: last restore-verification found ${dangling} receipt(s) referencing absent vault rows`,
      );
    }
    // Issue #411 action 1: the WAL shipper detected a FOREIGN checkpoint —
    // something other than the shipper checkpointed one of this vault's
    // databases, forcing a generation break (base re-clone). Correctness is
    // intact (verification caught it and re-based), so this is DEGRADED, not
    // error: it is a churn/perf signal that something else is checkpointing our
    // databases — most likely a stray connection with `wal_autocheckpoint`
    // unset — and someone should find it. Persisted in target state so the
    // probe recomputes it (a pushed report would be repainted green next probe).
    // Aged out on the LAST occurrence: a foreign checkpoint that stopped
    // recurring clears after 24 h, while an ongoing one keeps refreshing `atMs`
    // and stays degraded — simpler and self-clearing versus a "nonzero forever"
    // rule that would pin a months-old transient at degraded permanently.
    const lastForeign = target.walLastForeignCheckpoint;
    if (lastForeign && opts.now - lastForeign.atMs < DAY_MS) {
      if (worst !== 'error') worst = 'degraded';
      notes.push(
        `${vaultId}: ${target.walForeignCheckpointCount ?? 1} foreign checkpoint(s) detected ` +
          `(last: ${lastForeign.db} — ${lastForeign.reason}) — something else is checkpointing ` +
          `this vault's databases`,
      );
    }
    // Issue #408 G9: "a vault that has not been successfully restored within
    // N days raises an alert" — a backup that has never been restored is a
    // hypothesis, so restore-verification staleness alarms at ERROR, not
    // degraded. Baseline falls back to first-backup time so a fresh target
    // gets its 14-day grace instead of alarming immediately.
    const restoreBaseline =
      target.lastRestoreVerifiedAt ?? target.firstBackupAt ?? target.lastBackupAt;
    const restoreAgeMs = restoreBaseline
      ? opts.now - Date.parse(restoreBaseline)
      : Number.POSITIVE_INFINITY;
    if (restoreAgeMs >= 14 * DAY_MS) {
      worst = 'error';
      notes.push(`${vaultId}: no successful restore-verification within 14 days`);
    }
  }
  return {
    status: worst,
    detail: notes.length > 0 ? notes.join('; ') : `${rows.length} vault(s) backed up`,
  };
}
