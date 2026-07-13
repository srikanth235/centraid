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
  }
  return {
    status: worst,
    detail: notes.length > 0 ? notes.join('; ') : `${rows.length} vault(s) backed up`,
  };
}
