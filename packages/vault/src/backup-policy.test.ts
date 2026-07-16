import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapVault } from './bootstrap.js';
import { openVaultDb, type VaultDb } from './db.js';
import {
  DEFAULT_BACKUP_POLICY,
  MIN_RPO_SECONDS,
  BackupPolicyError,
  readBackupPolicy,
  resolveBackupPolicy,
  updateBackupPolicy,
} from './backup-policy.js';

describe('BackupPolicy', () => {
  let db: VaultDb;

  beforeEach(() => {
    db = openVaultDb();
    bootstrapVault(db, { ownerName: 'Asha' });
  });

  afterEach(() => db.close());

  it('resolves one complete default policy for a fresh vault', () => {
    expect(readBackupPolicy(db.vault)).toEqual(DEFAULT_BACKUP_POLICY);
  });

  it('updates all backup, custody, and byte-budget knobs in one settings document', () => {
    const policy = updateBackupPolicy(db.vault, {
      rpoSeconds: 900,
      snapshotIntervalHours: 168,
      verifyEveryDays: 30,
      casAck: 'replicated',
      outboxBudgetBytes: 2_000,
      reservedHeadroomBytes: 1_000,
      cacheBudgetBytes: 4_000,
      throttleBytesPerSec: 500,
      storageClass: ' STANDARD_IA ',
      walBaseRollBytes: 8_000,
      walBaseRollHours: 12,
    });

    expect(policy).toMatchObject({
      rpoSeconds: 900,
      snapshotIntervalHours: 168,
      verifyEveryDays: 30,
      casAck: 'replicated',
      outboxBudgetBytes: 2_000,
      reservedHeadroomBytes: 1_000,
      cacheBudgetBytes: 4_000,
      throttleBytesPerSec: 500,
      storageClass: 'STANDARD_IA',
      walBaseRollBytes: 8_000,
      walBaseRollHours: 12,
    });
    expect(readBackupPolicy(db.vault)).toEqual(policy);
  });

  it('uses null to restore defaults and clear optional knobs', () => {
    updateBackupPolicy(db.vault, {
      rpoSeconds: 900,
      cacheBudgetBytes: 1_000,
      storageClass: 'cold',
    });
    const policy = updateBackupPolicy(db.vault, {
      rpoSeconds: null,
      cacheBudgetBytes: null,
      storageClass: null,
    });

    expect(policy.rpoSeconds).toBe(DEFAULT_BACKUP_POLICY.rpoSeconds);
    expect(policy.cacheBudgetBytes).toBeUndefined();
    expect(policy.storageClass).toBeUndefined();
  });

  it('rejects an RPO below the declared floor and invalid acknowledgement modes', () => {
    expect(() => resolveBackupPolicy({ rpoSeconds: MIN_RPO_SECONDS - 1 })).toThrow(
      BackupPolicyError,
    );
    expect(() => resolveBackupPolicy({ casAck: 'strict' })).toThrow(/casAck/);
  });
});
