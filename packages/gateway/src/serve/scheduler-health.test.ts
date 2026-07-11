import { describe, expect, it } from 'vitest';
import { createSchedulerHealthProbe } from './scheduler-health.js';
import type { SchedulerLedgerSnapshot } from '@centraid/automation';

const EMPTY: SchedulerLedgerSnapshot = { missed: [] };

describe('createSchedulerHealthProbe', () => {
  it('reports ok when every vault has ticked recently', async () => {
    const probe = createSchedulerHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-a',
          snapshot: () => ({ lastTickAt: new Date(0).toISOString(), missed: [] }),
        },
      ],
      now: () => 30_000, // 30s after the tick — well inside the 3-period default
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1 vault scheduler ticking');
  });

  it('does not flag a vault that has never ticked yet (fresh boot, not stale)', async () => {
    const probe = createSchedulerHealthProbe({
      vaults: () => [{ vaultId: 'vault-a', snapshot: () => EMPTY }],
      now: () => 10 * 60_000,
    });
    expect((await probe()).status).toBe('ok');
  });

  it('flags degraded when a tick has gone stale past the threshold', async () => {
    const probe = createSchedulerHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-aaaaaaaa',
          snapshot: () => ({ lastTickAt: new Date(0).toISOString(), missed: [] }),
        },
      ],
      periodMs: 60_000,
      staleAfterPeriods: 3,
      now: () => 3 * 60_000 + 1, // just past 3 periods
    });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('tick stale');
    expect(result.detail).toContain('vault-aa');
  });

  it('stays ok exactly at the staleness threshold (strict greater-than)', async () => {
    const probe = createSchedulerHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-a',
          snapshot: () => ({ lastTickAt: new Date(0).toISOString(), missed: [] }),
        },
      ],
      periodMs: 60_000,
      staleAfterPeriods: 3,
      now: () => 3 * 60_000,
    });
    expect((await probe()).status).toBe('ok');
  });

  it('surfaces missed-window count + the latest entry even when ticking is healthy', async () => {
    const probe = createSchedulerHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-a',
          snapshot: () => ({
            lastTickAt: new Date(1_000_000).toISOString(),
            missed: [
              {
                automationRef: 'app/old',
                scheduledFor: new Date(1).toISOString(),
                recordedAt: new Date(2).toISOString(),
                reason: 'gateway-down',
              },
              {
                automationRef: 'app/newest',
                scheduledFor: new Date(3).toISOString(),
                recordedAt: new Date(4).toISOString(),
                reason: 'gateway-down',
              },
            ],
          }),
        },
      ],
      now: () => 1_000_000,
    });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('2 missed automation windows recorded');
    expect(result.detail).toContain('app/newest');
  });

  it('aggregates missed counts across multiple vaults', async () => {
    const probe = createSchedulerHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-a',
          snapshot: () => ({
            lastTickAt: new Date(0).toISOString(),
            missed: [
              {
                automationRef: 'a/one',
                scheduledFor: new Date(1).toISOString(),
                recordedAt: new Date(2).toISOString(),
                reason: 'gateway-down',
              },
            ],
          }),
        },
        {
          vaultId: 'vault-b',
          snapshot: () => ({
            lastTickAt: new Date(0).toISOString(),
            missed: [
              {
                automationRef: 'b/one',
                scheduledFor: new Date(1).toISOString(),
                recordedAt: new Date(2).toISOString(),
                reason: 'gateway-down',
              },
            ],
          }),
        },
      ],
      now: () => 1,
    });
    const result = await probe();
    expect(result.detail).toContain('2 missed automation windows recorded');
  });
});
