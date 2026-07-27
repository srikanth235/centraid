/**
 * Pure backup metric aggregation (issue #545 B8).
 */

import { describe, expect, it } from 'vitest';
import { aggregateUsage, computeStorageMetrics } from './backupMetrics.js';
import type { BackupStatusDTO } from './BackupCard.js';
import type { StorageConnectionUsageDTO } from '../../gateway-client.js';

describe(aggregateUsage, () => {
  it('returns null for empty / missing connections', () => {
    expect(aggregateUsage(null)).toBeNull();
    expect(aggregateUsage([])).toBeNull();
    expect(
      aggregateUsage([{ connectionId: 'c1', providerReported: null } as StorageConnectionUsageDTO]),
    ).toBeNull();
  });

  it('sums store bytes and keeps the max finite quota across connections', () => {
    const rows = [
      {
        connectionId: 'a',
        providerReported: {
          backup: { bytesStored: 10, quotaBytes: 100 },
          cas: { bytesStored: 5, quotaBytes: null },
        },
      },
      {
        connectionId: 'b',
        providerReported: {
          backup: { bytesStored: 20, quotaBytes: 50 },
          derived: { bytesStored: 3, quotaBytes: 9 },
        },
      },
    ] as StorageConnectionUsageDTO[];
    expect(aggregateUsage(rows)).toStrictEqual({
      backup: { bytesStored: 30, quotaBytes: 100 },
      cas: { bytesStored: 5, quotaBytes: null },
      derived: { bytesStored: 3, quotaBytes: 9 },
    });
  });
});

describe(computeStorageMetrics, () => {
  it('uses the oldest vault clocks and slowest declared cadence', () => {
    const now = Date.parse('2026-07-25T12:00:00.000Z');
    const oldestSnapshot = Date.parse('2026-07-24T10:00:00.000Z');
    const oldestVerify = Date.parse('2026-07-20T00:00:00.000Z');
    const oldestWal = Date.parse('2026-07-25T11:00:00.000Z');
    // Slowest policy: verifyEveryDays=14 → 14d beats snapshot 48h and RPO 120s.
    const slowestCadenceMs = 14 * 24 * 60 * 60 * 1000;
    const status = {
      configured: true,
      vaults: [
        {
          vaultId: 'v1',
          lastBackupAt: '2026-07-25T10:00:00.000Z',
          lastVerifyAt: '2026-07-20T00:00:00.000Z',
          lastWalDrainAt: '2026-07-25T11:00:00.000Z',
          pendingOffsite: { count: 0, bytes: 0 },
          policy: { rpoSeconds: 60, snapshotIntervalHours: 24, verifyEveryDays: 7 },
        },
        {
          vaultId: 'v2',
          lastBackupAt: '2026-07-24T10:00:00.000Z', // older snapshot
          lastVerifyAt: '2026-07-22T00:00:00.000Z',
          lastWalDrainAt: '2026-07-25T11:30:00.000Z',
          pendingOffsite: { count: 0, bytes: 0 },
          policy: { rpoSeconds: 120, snapshotIntervalHours: 48, verifyEveryDays: 14 },
        },
      ],
      home: { retention: { kind: 'none' }, restoreCostClass: 'free-egress' },
    } as BackupStatusDTO;

    const metrics = computeStorageMetrics(status, null, now);
    expect(metrics.freshness.declaredCadenceMs).toBe(slowestCadenceMs);
    expect(metrics.freshness.clocks).toStrictEqual({
      lastRegisteredSnapshotAt: oldestSnapshot,
      lastSuccessfulVerificationAt: oldestVerify,
      lastAckedWalSegmentAt: oldestWal,
      outboxDrainedWatermarkAt: oldestWal,
    });
    // T = min of four clocks = oldest verify.
    expect(metrics.freshness.tMs).toBe(oldestVerify);
    expect(metrics.freshness.ageMs).toBe(now - oldestVerify);

    // Any vault missing a clock forces that edge to null — inject one miss.
    const missing = computeStorageMetrics(
      {
        ...status,
        vaults: [status.vaults[0]!, { ...status.vaults[1]!, lastVerifyAt: undefined }],
      } as BackupStatusDTO,
      { backup: { bytesStored: 1, quotaBytes: 10 } },
      now,
    );
    expect(missing.freshness.status).toBe('unknown');
    expect(missing.freshness.tMs).toBeNull();
    expect(missing.freshness.clocks.lastSuccessfulVerificationAt).toBeNull();
    expect(missing.cost.bytesStored).toBe(1);
  });
});
