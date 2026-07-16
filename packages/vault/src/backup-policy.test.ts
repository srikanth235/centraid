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

  it('treats an empty/whitespace storageClass as unset, not an explicit class', () => {
    // db.ts reads storageClass as a falsy header, so an empty/whitespace value
    // must normalize to undefined rather than throw or pass through as "".
    expect(resolveBackupPolicy({ storageClass: '' }).storageClass).toBeUndefined();
    expect(resolveBackupPolicy({ storageClass: '   ' }).storageClass).toBeUndefined();
    // A real (trimmed) class is still honored, and a non-string is still rejected.
    expect(resolveBackupPolicy({ storageClass: ' GLACIER ' }).storageClass).toBe('GLACIER');
    expect(() => resolveBackupPolicy({ storageClass: 7 })).toThrow(/storageClass/);
  });

  it('resolves and round-trips the directToColdOriginals knob (issue #425 Wave 3)', () => {
    // Absent by default — the resolver applies its own default-ON config.
    expect(readBackupPolicy(db.vault).directToColdOriginals).toBeUndefined();
    const policy = updateBackupPolicy(db.vault, {
      directToColdOriginals: { enabled: false, minBytes: 1024, mimePrefixes: ['video/'] },
    });
    expect(policy.directToColdOriginals).toEqual({
      enabled: false,
      minBytes: 1024,
      mimePrefixes: ['video/'],
    });
    expect(readBackupPolicy(db.vault).directToColdOriginals).toEqual(policy.directToColdOriginals);
    // null clears it back to the default-ON (absent) state.
    expect(
      updateBackupPolicy(db.vault, { directToColdOriginals: null }).directToColdOriginals,
    ).toBeUndefined();
  });

  it('validates the directToColdOriginals shape', () => {
    expect(() => resolveBackupPolicy({ directToColdOriginals: 'on' })).toThrow(
      /directToColdOriginals/,
    );
    expect(() => resolveBackupPolicy({ directToColdOriginals: { enabled: 'yes' } })).toThrow(
      /enabled/,
    );
    expect(() => resolveBackupPolicy({ directToColdOriginals: { minBytes: -1 } })).toThrow(
      /minBytes/,
    );
    expect(() => resolveBackupPolicy({ directToColdOriginals: { minBytes: 1.5 } })).toThrow(
      /minBytes/,
    );
    expect(() =>
      resolveBackupPolicy({ directToColdOriginals: { mimePrefixes: ['video/', ''] } }),
    ).toThrow(/mimePrefixes/);
    expect(() =>
      resolveBackupPolicy({ directToColdOriginals: { mimePrefixes: 'video/' } }),
    ).toThrow(/mimePrefixes/);
    // A partial object is accepted; unspecified sub-fields fall back at read.
    expect(
      resolveBackupPolicy({ directToColdOriginals: { minBytes: 42 } }).directToColdOriginals,
    ).toEqual({ minBytes: 42 });
  });
});
