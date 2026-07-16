// evaluateBackupHealth — the WAL foreign-checkpoint degraded signal (issue #411
// action 1). A foreign checkpoint is a churn/perf event the shipper detected and
// self-healed (generation break), so it surfaces as DEGRADED, not error, and
// ages out on its last occurrence.
import { expect, test } from 'vitest';

import { evaluateBackupHealth } from './backup-health.js';
import type { BackupState, BackupTargetState } from './backup-state.js';

const NOW = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;

/** An otherwise-healthy target: fresh backup, fresh verify, fresh restore-verify. */
function healthyTarget(over: Partial<BackupTargetState> = {}): BackupTargetState {
  const iso = new Date(NOW - HOUR_MS).toISOString();
  return {
    targetId: 't1',
    label: 'label',
    generation: 1,
    firstBackupAt: iso,
    lastBackupAt: iso,
    lastVerifiedAt: iso,
    lastRestoreVerifiedAt: iso,
    lastWalDrainAt: new Date(NOW - 30_000).toISOString(),
    ...over,
  };
}

function stateWith(target: BackupTargetState): BackupState {
  return {
    targets: { 'vault-a': target },
    casReconciliations: {},
    sourceInstanceId: 'deadbeef',
    recoveryKit: { confirmedAt: null },
  };
}

test('a recent foreign checkpoint degrades with a count + last-reason message', () => {
  const target = healthyTarget({
    walForeignCheckpointCount: 3,
    walLastForeignCheckpoint: {
      atMs: NOW - HOUR_MS,
      db: 'journal',
      reason: 'wal-salts-changed-without-our-checkpoint',
    },
  });
  const res = evaluateBackupHealth({ state: stateWith(target), now: NOW });
  expect(res.status).toBe('degraded');
  expect(res.detail).toContain('3 foreign checkpoint(s)');
  expect(res.detail).toContain('journal');
  expect(res.detail).toContain('wal-salts-changed-without-our-checkpoint');
});

test('a foreign checkpoint older than 24h no longer degrades (aged out)', () => {
  const target = healthyTarget({
    walForeignCheckpointCount: 3,
    walLastForeignCheckpoint: {
      atMs: NOW - 25 * HOUR_MS,
      db: 'journal',
      reason: 'wal-reset-during-capture',
    },
  });
  const res = evaluateBackupHealth({ state: stateWith(target), now: NOW });
  expect(res.status).toBe('ok');
  expect(res.detail).not.toContain('foreign checkpoint');
});

test('no foreign checkpoint recorded → ok, no note', () => {
  const res = evaluateBackupHealth({ state: stateWith(healthyTarget()), now: NOW });
  expect(res.status).toBe('ok');
  expect(res.detail).not.toContain('foreign checkpoint');
});

test('a real error still outranks a recent foreign checkpoint', () => {
  const target = healthyTarget({
    lastRestoreVerifyError: 'segment object corrupt',
    walForeignCheckpointCount: 1,
    walLastForeignCheckpoint: {
      atMs: NOW - HOUR_MS,
      db: 'vault',
      reason: 'main-db-file-changed-without-our-checkpoint',
    },
  });
  const res = evaluateBackupHealth({ state: stateWith(target), now: NOW });
  expect(res.status).toBe('error');
});

test('a provider policy echo drift is a sticky degraded health signal', () => {
  const target = healthyTarget({
    providerPolicy: {
      status: 'drift',
      desired: {
        rpoSeconds: 60,
        snapshotIntervalHours: 24,
        verifyEveryDays: 7,
        casAck: 'receipt',
      },
      checkedAt: new Date(NOW).toISOString(),
      echo: {
        rpoSeconds: 120,
        snapshotIntervalHours: 24,
        verifyEveryDays: 7,
        casAck: 'receipt',
        declaredAt: Math.floor(NOW / 1000),
      },
    },
  });
  const res = evaluateBackupHealth({ state: stateWith(target), now: NOW });
  expect(res.status).toBe('degraded');
  expect(res.detail).toContain('provider policy echo differs');
});

test('a typed provider policy rejection raises error health', () => {
  const target = healthyTarget({
    providerPolicy: {
      status: 'rejected',
      desired: {
        rpoSeconds: 60,
        snapshotIntervalHours: 24,
        verifyEveryDays: 7,
        casAck: 'replicated',
      },
      checkedAt: new Date(NOW).toISOString(),
      error: 'replicated acknowledgement unavailable',
      errorCode: 'policy_unmet',
    },
  });
  const res = evaluateBackupHealth({ state: stateWith(target), now: NOW });
  expect(res.status).toBe('error');
  expect(res.detail).toContain('provider policy rejected');
});

test('WAL replication older than twice the per-vault RPO raises an error', () => {
  const target = healthyTarget({
    lastWalDrainAt: new Date(NOW - 121_000).toISOString(),
  });
  const res = evaluateBackupHealth({ state: stateWith(target), now: NOW });
  expect(res.status).toBe('error');
  expect(res.detail).toContain('WAL replication exceeded 2× the 60s RPO');
});
