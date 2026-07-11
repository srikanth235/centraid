import { describe, expect, it } from 'vitest';
import type { UsageByStore } from '@centraid/backup';
import {
  createStorageQuotaHealthProbe,
  QUOTA_DEGRADED_AT,
  QUOTA_ERROR_AT,
  type StorageQuotaConnectionEntry,
} from './storage-quota-health.js';

function report(bytesStored: number, quotaBytes: number | null): UsageByStore['backup'] {
  return { bytesStored, objectCount: 1, quotaBytes, period: { start: 0, end: 1 } };
}

function probeWith(
  connections: StorageQuotaConnectionEntry[],
  usageByConnection: Record<string, UsageByStore | null>,
) {
  return createStorageQuotaHealthProbe({
    connections: async () => connections,
    usageFor: async (id) => ({ providerReported: usageByConnection[id] ?? null }),
  });
}

describe('createStorageQuotaHealthProbe', () => {
  it('reports ok with "no provider-kind" when there are no connections at all', async () => {
    const probe = probeWith([], {});
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('no provider-kind');
  });

  it('ignores byo-s3 connections entirely (no usage endpoint to watch)', async () => {
    const probe = probeWith(
      [{ connectionId: 'c1', name: 'My bucket', kind: 'byo-s3' }],
      { c1: { backup: report(999_999, 1_000_000) } },
    );
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('no provider-kind');
  });

  it('reports ok "unmetered" when a provider connection has no cached usage yet', async () => {
    const probe = probeWith([{ connectionId: 'c1', name: 'Clawgnition', kind: 'provider' }], {});
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('unmetered');
  });

  it('reports ok "unmetered" when the provider reports quotaBytes: null', async () => {
    const probe = probeWith(
      [{ connectionId: 'c1', name: 'Clawgnition', kind: 'provider' }],
      { c1: { backup: report(50_000, null) } },
    );
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('unmetered');
  });

  it('reports ok well under the degraded watermark', async () => {
    const probe = probeWith(
      [{ connectionId: 'c1', name: 'Clawgnition', kind: 'provider' }],
      { c1: { backup: report(100, 1000) } }, // 10%
    );
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('metered store(s) within quota');
  });

  it('reports degraded at the 80% watermark', async () => {
    const quota = 1000;
    const probe = probeWith(
      [{ connectionId: 'c1', name: 'Clawgnition', kind: 'provider' }],
      { c1: { backup: report(Math.ceil(quota * QUOTA_DEGRADED_AT), quota) } },
    );
    const result = await probe();
    expect(result.status).toBe('degraded');
    expect(result.detail).toContain('Clawgnition/backup');
  });

  it('reports error at the 95% watermark', async () => {
    const quota = 1000;
    const probe = probeWith(
      [{ connectionId: 'c1', name: 'Clawgnition', kind: 'provider' }],
      { c1: { backup: report(Math.ceil(quota * QUOTA_ERROR_AT), quota) } },
    );
    const result = await probe();
    expect(result.status).toBe('error');
  });

  it('stays ok just under the degraded watermark (strict-greater-or-equal thresholds)', async () => {
    const quota = 1000;
    const probe = probeWith(
      [{ connectionId: 'c1', name: 'Clawgnition', kind: 'provider' }],
      { c1: { backup: report(Math.floor(quota * QUOTA_DEGRADED_AT) - 1, quota) } },
    );
    const result = await probe();
    expect(result.status).toBe('ok');
  });

  it('worst-of across store classes: cas over quota wins even when backup is fine', async () => {
    const probe = probeWith(
      [{ connectionId: 'c1', name: 'Clawgnition', kind: 'provider' }],
      {
        c1: {
          backup: report(10, 1000), // 1%, fine
          cas: report(980, 1000), // 98%, error
        },
      },
    );
    const result = await probe();
    expect(result.status).toBe('error');
    expect(result.detail).toContain('cas');
  });

  it('worst-of across multiple connections: one error connection dominates', async () => {
    const probe = probeWith(
      [
        { connectionId: 'c1', name: 'Fine Provider', kind: 'provider' },
        { connectionId: 'c2', name: 'Full Provider', kind: 'provider' },
      ],
      {
        c1: { backup: report(10, 1000) },
        c2: { backup: report(999, 1000) },
      },
    );
    const result = await probe();
    expect(result.status).toBe('error');
    expect(result.detail).toContain('Full Provider');
  });
});
