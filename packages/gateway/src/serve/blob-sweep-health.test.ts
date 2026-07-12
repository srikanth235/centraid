import { describe, expect, it } from 'vitest';
import { createBlobSweepHealthProbe, type BlobCustodyCounts } from './blob-sweep-health.js';

const ZERO_COUNTS: BlobCustodyCounts = {
  'local-only': 0,
  replicated: 0,
  'remote-only': 0,
  missing: 0,
};

const NEVER_SWEPT = { lastCompletedAt: null, lastError: null, consecutiveFailures: 0 };

describe('createBlobSweepHealthProbe', () => {
  it('reports ok, local-only-only, when no vault configures an s3 tier', async () => {
    const probe = createBlobSweepHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          s3Configured: () => false,
          counts: () => ({ ...ZERO_COUNTS, 'local-only': 4 }),
          sweepStatus: () => NEVER_SWEPT,
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('no s3 tier configured');
    expect(result.detail).toContain('4 local-only');
  });

  it('reports ok when s3 is configured and the sweep has cleared the backlog', async () => {
    const probe = createBlobSweepHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          s3Configured: () => true,
          counts: () => ({ ...ZERO_COUNTS, replicated: 3 }),
          sweepStatus: () => ({
            lastCompletedAt: new Date(0).toISOString(),
            lastError: null,
            consecutiveFailures: 0,
          }),
        },
      ],
      now: () => 5_000, // well inside the 1h default staleness window
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1 vault(s) with s3 configured');
    expect(result.detail).toContain('3 replicated');
  });

  it('honestly reports "sweep never ran" for an s3-configured vault with no completed sweep yet', async () => {
    const probe = createBlobSweepHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-aaaaaaaa',
          s3Configured: () => true,
          counts: () => ({ ...ZERO_COUNTS, 'local-only': 2 }),
          sweepStatus: () => NEVER_SWEPT,
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('sweep never ran');
    expect(result.detail).toContain('vault-aa');
  });

  it('flags a stale sweep with an outstanding local-only backlog as degraded', async () => {
    const probe = createBlobSweepHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-aaaaaaaa',
          s3Configured: () => true,
          counts: () => ({ ...ZERO_COUNTS, 'local-only': 5 }),
          sweepStatus: () => ({
            lastCompletedAt: new Date(0).toISOString(),
            lastError: null,
            consecutiveFailures: 0,
          }),
        },
      ],
      staleAfterMs: 60_000,
      now: () => 120_000, // 2 minutes since the last sweep, past the 1min threshold
    });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('last swept');
    expect(result.detail).toContain('backlog 5');
  });

  it('does not flag a stale sweep when the backlog is already zero', async () => {
    const probe = createBlobSweepHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          s3Configured: () => true,
          counts: () => ({ ...ZERO_COUNTS, replicated: 5 }),
          sweepStatus: () => ({
            lastCompletedAt: new Date(0).toISOString(),
            lastError: null,
            consecutiveFailures: 0,
          }),
        },
      ],
      staleAfterMs: 60_000,
      now: () => 120_000,
    });
    expect((await probe()).status).toBe('ok');
  });

  it('degrades on a single recent sweep failure, below the persistent-failure streak', async () => {
    const probe = createBlobSweepHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          s3Configured: () => true,
          counts: () => ZERO_COUNTS,
          sweepStatus: () => ({
            lastCompletedAt: null,
            lastError: 'ECONNREFUSED',
            consecutiveFailures: 1,
          }),
        },
      ],
      persistentFailureStreak: 3,
    });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('escalates to error once consecutive failures reach the persistent-failure streak', async () => {
    const probe = createBlobSweepHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          s3Configured: () => true,
          counts: () => ZERO_COUNTS,
          sweepStatus: () => ({
            lastCompletedAt: null,
            lastError: 'ECONNREFUSED',
            consecutiveFailures: 3,
          }),
        },
      ],
      persistentFailureStreak: 3,
    });
    const result = await probe();
    expect(result.status).toBe('error');
    expect(result.detail).toContain('persistently failing');
    expect(result.detail).toContain('ECONNREFUSED');
  });

  it('aggregates local-only/replicated counts across multiple vaults', async () => {
    const probe = createBlobSweepHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          s3Configured: () => false,
          counts: () => ({ ...ZERO_COUNTS, 'local-only': 2 }),
          sweepStatus: () => NEVER_SWEPT,
        },
        {
          vaultId: 'v2',
          s3Configured: () => true,
          counts: () => ({ ...ZERO_COUNTS, replicated: 7 }),
          sweepStatus: () => ({
            lastCompletedAt: new Date(0).toISOString(),
            lastError: null,
            consecutiveFailures: 0,
          }),
        },
      ],
      now: () => 1_000,
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('2 local-only');
    expect(result.detail).toContain('7 replicated');
  });
});
