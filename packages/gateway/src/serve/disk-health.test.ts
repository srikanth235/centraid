import { describe, expect, it } from 'vitest';
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

describe('formatBytes', () => {
  it('formats across units', () => {
    expect(formatBytes(500)).toBe('500 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
    expect(formatBytes(3 * GIB)).toBe('3.0 GB');
  });
});
