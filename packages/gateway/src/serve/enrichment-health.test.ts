import { describe, expect, it } from 'vitest';
import { createEnrichmentHealthProbe, type EnrichmentAutomationRow } from './enrichment-health.js';

function row(id: string, enabled: boolean): EnrichmentAutomationRow {
  return { id, enabled, ref: `${id}/${id}` };
}

describe('createEnrichmentHealthProbe', () => {
  it('reports ok, zero enabled, when no enricher is installed', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [{ vaultId: 'v1', listAutomations: async () => [], recentRuns: () => [] }],
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('0 of 0 enrichers enabled');
  });

  it('ignores automations that are not enrichers, and counts disabled ones as installed only', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          listAutomations: async () => [row('photo-captioner', false), row('some-other-app', true)],
          recentRuns: () => [],
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('0 of 1 enricher enabled');
  });

  it('reports ok for an enabled enricher that has never fired yet (honest unknown, not a failure)', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          listAutomations: async () => [row('doc-filer', true)],
          recentRuns: () => [],
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1 of 1 enricher enabled');
  });

  it('reports ok for an enabled enricher whose latest run succeeded', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          listAutomations: async () => [row('doc-filer', true)],
          recentRuns: () => [{ ok: true, endedAt: 1_000 }],
        },
      ],
      now: () => 2_000,
    });
    expect((await probe()).status).toBe('ok');
  });

  it('degrades on a single recent failure, below the persistent-failure streak', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-aaaaaaaa',
          listAutomations: async () => [row('face-proposer', true)],
          recentRuns: () => [{ ok: false }, { ok: true }, { ok: true }],
        },
      ],
      persistentFailureStreak: 3,
    });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('recent failure');
    expect(result.detail).toContain('vault-aa/face-proposer');
  });

  it('escalates to error when the last N runs (the streak) all failed', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-aaaaaaaa',
          listAutomations: async () => [row('face-proposer', true)],
          recentRuns: () => [{ ok: false }, { ok: false }, { ok: false }],
        },
      ],
      persistentFailureStreak: 3,
    });
    const result = await probe();
    expect(result.status).toBe('error');
    expect(result.detail).toContain('persistently failing');
    expect(result.detail).toContain('vault-aa/face-proposer');
  });

  it('flags a successful-but-stale enricher as degraded', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          listAutomations: async () => [row('trip-albums', true)],
          recentRuns: () => [{ ok: true, endedAt: 0 }],
        },
      ],
      staleAfterMs: 60_000,
      now: () => 120_000,
    });
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('stale');
  });

  it('tolerates a vault whose workspace is not mounted yet, skipping it rather than erroring', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: 'v1',
          listAutomations: async () => {
            throw new Error('gateway: vault v1 workspace not mounted yet');
          },
          recentRuns: () => [],
        },
      ],
    });
    await expect(probe()).resolves.toEqual({
      status: 'ok',
      detail: '0 of 0 enrichers enabled',
    });
  });

  it('aggregates enabled counts across multiple vaults', async () => {
    const probe = createEnrichmentHealthProbe({
      vaults: () => [
        {
          vaultId: 'vault-a',
          listAutomations: async () => [row('doc-filer', true)],
          recentRuns: () => [],
        },
        {
          vaultId: 'vault-b',
          listAutomations: async () => [row('doc-filer', true), row('trip-albums', false)],
          recentRuns: () => [],
        },
      ],
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('2 of 3 enrichers enabled');
  });
});
