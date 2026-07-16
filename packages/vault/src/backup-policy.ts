import type { DatabaseSync } from 'node:sqlite';

/**
 * One owner-visible policy for every backup/custody clock and byte budget
 * (issue #414). The destination itself remains a separate storage-connection
 * choice; this document describes how that destination is used.
 */
export interface BackupPolicy {
  /** Maximum intended offsite WAL lag. Also drives the vault WAL capture tick. */
  rpoSeconds: number;
  snapshotIntervalHours: number;
  verifyEveryDays: number;
  /** Receipt is always durable locally; replicated waits for provider custody. */
  casAck: 'receipt' | 'replicated';
  /** Transit capacity for remote-primary fallback uploads. */
  outboxBudgetBytes: number;
  /** Space reserved for WAL staging, snapshot assembly, journal writes, and the OS. */
  reservedHeadroomBytes: number;
  /** Omitted means derive a cache budget from the real volume. */
  cacheBudgetBytes?: number;
  /** Omitted/zero means unthrottled. */
  throttleBytesPerSec?: number;
  /** Provider-defined S3 storage class. */
  storageClass?: string;
  /** WAL generation base-roll controls. */
  walBaseRollBytes: number;
  walBaseRollHours: number;
}

export type BackupPolicyPatch = {
  [K in keyof BackupPolicy]?: BackupPolicy[K] | null;
};

export const MIN_RPO_SECONDS = 30;
export const DEFAULT_BACKUP_POLICY: Readonly<BackupPolicy> = Object.freeze({
  rpoSeconds: 60,
  snapshotIntervalHours: 24,
  verifyEveryDays: 7,
  casAck: 'receipt',
  outboxBudgetBytes: 512 * 1024 ** 2,
  reservedHeadroomBytes: 256 * 1024 ** 2,
  walBaseRollBytes: 16 * 1024 ** 2,
  walBaseRollHours: 24,
});

export class BackupPolicyError extends Error {
  constructor(message: string) {
    super(`backup policy: ${message}`);
    this.name = 'BackupPolicyError';
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function positiveNumber(value: unknown, field: string, floor = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < floor || value <= 0) {
    throw new BackupPolicyError(
      `\`${field}\` must be a finite number ${floor > 0 ? `>= ${floor}` : '> 0'}`,
    );
  }
  return value;
}

function optionalPositiveNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === 0) return undefined;
  return positiveNumber(value, field);
}

/** Validate and resolve a stored or request policy against the v0 defaults. */
export function resolveBackupPolicy(value: unknown): BackupPolicy {
  const raw = record(value);
  const casAck = raw.casAck ?? DEFAULT_BACKUP_POLICY.casAck;
  if (casAck !== 'receipt' && casAck !== 'replicated') {
    throw new BackupPolicyError('`casAck` must be "receipt" or "replicated"');
  }
  const storageClassRaw = raw.storageClass;
  const cacheBudgetBytes = optionalPositiveNumber(raw.cacheBudgetBytes, 'cacheBudgetBytes');
  const throttleBytesPerSec = optionalPositiveNumber(
    raw.throttleBytesPerSec,
    'throttleBytesPerSec',
  );
  if (
    storageClassRaw !== undefined &&
    storageClassRaw !== null &&
    (typeof storageClassRaw !== 'string' || storageClassRaw.trim() === '')
  ) {
    throw new BackupPolicyError('`storageClass` must be a non-empty string when set');
  }
  return {
    rpoSeconds: positiveNumber(
      raw.rpoSeconds ?? DEFAULT_BACKUP_POLICY.rpoSeconds,
      'rpoSeconds',
      MIN_RPO_SECONDS,
    ),
    snapshotIntervalHours: positiveNumber(
      raw.snapshotIntervalHours ?? DEFAULT_BACKUP_POLICY.snapshotIntervalHours,
      'snapshotIntervalHours',
    ),
    verifyEveryDays: positiveNumber(
      raw.verifyEveryDays ?? DEFAULT_BACKUP_POLICY.verifyEveryDays,
      'verifyEveryDays',
    ),
    casAck,
    outboxBudgetBytes: positiveNumber(
      raw.outboxBudgetBytes ?? DEFAULT_BACKUP_POLICY.outboxBudgetBytes,
      'outboxBudgetBytes',
    ),
    reservedHeadroomBytes: positiveNumber(
      raw.reservedHeadroomBytes ?? DEFAULT_BACKUP_POLICY.reservedHeadroomBytes,
      'reservedHeadroomBytes',
    ),
    ...(cacheBudgetBytes !== undefined ? { cacheBudgetBytes } : {}),
    ...(throttleBytesPerSec !== undefined ? { throttleBytesPerSec } : {}),
    ...(typeof storageClassRaw === 'string' ? { storageClass: storageClassRaw.trim() } : {}),
    walBaseRollBytes: positiveNumber(
      raw.walBaseRollBytes ?? DEFAULT_BACKUP_POLICY.walBaseRollBytes,
      'walBaseRollBytes',
    ),
    walBaseRollHours: positiveNumber(
      raw.walBaseRollHours ?? DEFAULT_BACKUP_POLICY.walBaseRollHours,
      'walBaseRollHours',
    ),
  };
}

function readSettings(vault: DatabaseSync): Record<string, unknown> {
  const row = vault.prepare('SELECT settings_json FROM core_vault LIMIT 1').get() as
    | { settings_json: string | null }
    | undefined;
  if (!row?.settings_json) return {};
  try {
    return record(JSON.parse(row.settings_json));
  } catch {
    return {};
  }
}

export function readBackupPolicy(vault: DatabaseSync): BackupPolicy {
  return resolveBackupPolicy(readSettings(vault).backup_policy);
}

/**
 * Merge a partial owner update. `null` clears an optional knob or restores a
 * required knob to its default. Validation happens before the settings row is
 * written, so a bad request cannot partially change policy.
 */
export function updateBackupPolicy(vault: DatabaseSync, patch: BackupPolicyPatch): BackupPolicy {
  const settings = readSettings(vault);
  const current = record(settings.backup_policy);
  for (const key of Object.keys(patch) as (keyof BackupPolicy)[]) {
    const value = patch[key];
    if (value === null || value === undefined) delete current[key];
    else current[key] = value;
  }
  const resolved = resolveBackupPolicy(current);
  settings.backup_policy = resolved;
  vault.prepare('UPDATE core_vault SET settings_json = ?').run(JSON.stringify(settings));
  return resolved;
}
