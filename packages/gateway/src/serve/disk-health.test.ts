import { describe, expect, it } from 'vitest';
import { DiskFullTracker } from '@centraid/vault';
import {
  createDiskHealthProbe,
  DISK_DEGRADED_BELOW_BYTES,
  DISK_ERROR_BELOW_BYTES,
  formatBytes,
} from './disk-health.js';

const GIB = 1024 ** 3;

function statfsReturning(freeBytes: number, totalBytes: number) {
  // bsize=1 keeps the math trivial to reason about in the assertions below.
  return () => ({ bavail: freeBytes, bsize: 1, blocks: totalBytes });
}

describe('createDiskHealthProbe', () => {
  it('reports ok well above the degraded watermark', async () => {
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('50.0 GB free of 100.0 GB');
  });

  it('reports degraded just under the degraded watermark', async () => {
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [],
      statfs: statfsReturning(DISK_DEGRADED_BELOW_BYTES - 1, 100 * GIB),
    });
    expect((await probe()).status).toBe('degraded');
  });

  it('reports error under the error watermark', async () => {
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [],
      statfs: statfsReturning(DISK_ERROR_BELOW_BYTES - 1, 100 * GIB),
    });
    const result = await probe();
    expect(result.status).toBe('error');
  });

  it('stays ok exactly at the degraded watermark (thresholds are strict-less-than)', async () => {
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [],
      statfs: statfsReturning(DISK_DEGRADED_BELOW_BYTES, 100 * GIB),
    });
    expect((await probe()).status).toBe('ok');
  });

  it('includes per-vault DB size in the detail, summed from vault.db + journal.db + their -wal files', async () => {
    const sizes: Record<string, number> = {
      '/vaults/v1/vault.db': 10 * 1024 * 1024,
      '/vaults/v1/vault.db-wal': 1 * 1024 * 1024,
      '/vaults/v1/journal.db': 5 * 1024 * 1024,
      // journal.db-wal deliberately absent — fileSize() below returns 0 for it.
    };
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [{ vaultId: 'vault-0001-abcdef', dir: '/vaults/v1' }],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
      fileSize: (file) => sizes[file] ?? 0,
    });
    const result = await probe();
    expect(result.detail).toContain('vault-00');
    expect(result.detail).toContain('16.0 MB');
  });

  it('never statSyncs into a blob CAS directory — only the four fixed filenames', async () => {
    const seen: string[] = [];
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [{ vaultId: 'v1', dir: '/vaults/v1' }],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
      fileSize: (file) => {
        seen.push(file);
        return 0;
      },
    });
    await probe();
    expect(seen.sort()).toEqual(
      [
        '/vaults/v1/vault.db',
        '/vaults/v1/vault.db-wal',
        '/vaults/v1/journal.db',
        '/vaults/v1/journal.db-wal',
      ].sort(),
    );
  });
});

describe('createDiskHealthProbe: disk-full tracker (issue #351 wave 4)', () => {
  it('forces error and names the event even when statfs looks fine', async () => {
    const tracker = new DiskFullTracker();
    tracker.report(Object.assign(new Error('no space left'), { code: 'ENOSPC' }), 'blob CAS write');
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB), // plenty free right now
      diskFullTracker: tracker,
    });
    const result = await probe();
    expect(result.status).toBe('error');
    expect(result.detail).toContain('ENOSPC observed at');
    expect(result.detail).toContain('blob CAS write');
  });

  it('surfaces the event for one tick, then clears once a recovered reading has been served', async () => {
    const tracker = new DiskFullTracker();
    tracker.report(
      Object.assign(new Error('no space left'), { code: 'ENOSPC' }),
      'gateway log persistence',
    );
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
      diskFullTracker: tracker,
    });

    const first = await probe();
    expect(first.status).toBe('error');
    expect(first.detail).toContain('ENOSPC observed');
    // The recovered reading just served already cleared the event — the
    // NEXT tick goes green, without needing a second recovered reading.
    expect(tracker.current()).toBeNull();

    const second = await probe();
    expect(second.status).toBe('ok');
  });

  it('a low reading still forces error even without a tracked event (unchanged threshold behavior)', async () => {
    const tracker = new DiskFullTracker();
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [],
      statfs: statfsReturning(DISK_ERROR_BELOW_BYTES - 1, 100 * GIB),
      diskFullTracker: tracker,
    });
    const result = await probe();
    expect(result.status).toBe('error');
    expect(result.detail).not.toContain('ENOSPC observed');
  });

  it('defaults to the process-wide sharedDiskFullTracker when none is injected', async () => {
    const probe = createDiskHealthProbe({
      rootDir: '/vaults',
      vaults: () => [],
      statfs: statfsReturning(50 * GIB, 100 * GIB),
    });
    // No tracker injected and nothing reported into the shared one in this
    // test run — must behave exactly like the pre-#351-wave-4 probe.
    expect((await probe()).status).toBe('ok');
  });
});

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * GIB)).toBe('3.0 GB');
  });
});
