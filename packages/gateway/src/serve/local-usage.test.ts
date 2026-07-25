import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { tempDir } from '@centraid/test-kit/temp-dir';
import { LocalUsageScanner, walkDirBytes, type LocalUsageOptions } from './local-usage.js';

// The component walker (issue #544). What matters here is that the figures
// are attributable — a byte lands under exactly one component — and that the
// cache actually prevents re-walking, because the whole point of the TTL is
// that a UI polling every minute must not re-read a blob CAS every minute.

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

async function vaultFixture(): Promise<{ root: string; vaultDir: string }> {
  const root = await tempDir('centraid-local-usage-');
  roots.push(root);
  const vaultDir = path.join(root, 'vaults', 'v1');
  await fs.mkdir(path.join(vaultDir, 'blobs', 'ab'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'apps', 'tasks'), { recursive: true });
  await fs.mkdir(path.join(vaultDir, 'code'), { recursive: true });
  await fs.writeFile(path.join(vaultDir, 'vault.db'), 'v'.repeat(300));
  await fs.writeFile(path.join(vaultDir, 'journal.db'), 'j'.repeat(1000));
  await fs.writeFile(path.join(vaultDir, 'journal.db-wal'), 'w'.repeat(200));
  await fs.writeFile(path.join(vaultDir, 'blobs', 'ab', 'cd.bin'), 'b'.repeat(5000));
  await fs.writeFile(path.join(vaultDir, 'apps', 'tasks', 'data.sqlite'), 'a'.repeat(400));
  await fs.writeFile(path.join(vaultDir, 'code', 'HEAD'), 'c'.repeat(50));
  return { root, vaultDir };
}

function scannerFor(
  root: string,
  vaultDir: string,
  over: Partial<LocalUsageOptions> = {},
): LocalUsageScanner {
  return new LocalUsageScanner({
    rootDir: root,
    vaults: () => [{ vaultId: 'v1', name: 'Personal', dir: vaultDir }],
    gatewayDirs: () => ({}),
    statfs: () => ({ bavail: 100, bsize: 1, blocks: 1000 }),
    ...over,
  });
}

describe('walkDirBytes', () => {
  it('sums a tree recursively and counts its files', async () => {
    const { vaultDir } = await vaultFixture();
    const result = await walkDirBytes(path.join(vaultDir, 'blobs'));
    expect(result).toMatchObject({ bytes: 5000, files: 1 });
    expect(result.unreadable).toBeUndefined();
  });

  it('reports a missing directory as zero, not an error', async () => {
    const { root } = await vaultFixture();
    expect(await walkDirBytes(path.join(root, 'nope'))).toMatchObject({ bytes: 0, files: 0 });
  });

  it('does not follow symlinks out of the tree', async () => {
    const { root, vaultDir } = await vaultFixture();
    const outside = path.join(root, 'outside');
    await fs.mkdir(outside, { recursive: true });
    await fs.writeFile(path.join(outside, 'huge.bin'), 'x'.repeat(100_000));
    await fs.symlink(outside, path.join(vaultDir, 'code', 'link'));
    // A link into the user's home would otherwise bill their whole disk here.
    expect((await walkDirBytes(path.join(vaultDir, 'code'))).bytes).toBe(50);
  });
});

describe('LocalUsageScanner', () => {
  it('attributes every byte to exactly one component, and totals them', async () => {
    const { root, vaultDir } = await vaultFixture();
    const report = await scannerFor(root, vaultDir).report();

    const vault = report.vaults[0]!;
    const byComponent = new Map(vault.components.map((c) => [c.component, c.bytes]));
    // The ledger is journal.db + its WAL; vault.db is its own component.
    expect(byComponent.get('ledger')).toBe(1200);
    expect(byComponent.get('vault-db')).toBe(300);
    expect(byComponent.get('attachments')).toBe(5000);
    expect(byComponent.get('apps')).toBe(400);
    expect(byComponent.get('code')).toBe(50);

    const summed = vault.components.reduce((sum, c) => sum + c.bytes, 0);
    expect(vault.bytes).toBe(summed);
    expect(report.totalBytes).toBe(summed);
    expect(report.disk).toEqual({ freeBytes: 100, totalBytes: 1000 });
  });

  it('bills gateway-level directories separately from any vault', async () => {
    const { root, vaultDir } = await vaultFixture();
    const logsDir = path.join(root, 'gateway-logs');
    await fs.mkdir(logsDir, { recursive: true });
    await fs.writeFile(path.join(logsDir, 'a.jsonl'), 'l'.repeat(700));

    const report = await scannerFor(root, vaultDir, {
      gatewayDirs: () => ({ logs: logsDir, templates: undefined }),
    }).report();

    expect(report.components).toHaveLength(1);
    expect(report.components[0]).toMatchObject({ component: 'logs', bytes: 700, files: 1 });
    expect(report.totalBytes).toBe(report.vaults[0]!.bytes + 700);
  });

  it('serves a cached report inside the TTL without re-walking', async () => {
    const { root, vaultDir } = await vaultFixture();
    let walks = 0;
    let clock = 1_000_000;
    const scanner = scannerFor(root, vaultDir, {
      ttlMs: 60_000,
      now: () => clock,
      vaults: () => {
        walks += 1;
        return [{ vaultId: 'v1', dir: vaultDir }];
      },
    });

    await scanner.report();
    expect(walks).toBe(1);
    await scanner.report();
    await scanner.report();
    expect(walks).toBe(1);

    // Past the TTL the stale report is still served immediately, and the
    // refresh it kicks lands for the NEXT read.
    clock += 60_001;
    await scanner.report();
    await Promise.resolve();
    await scanner.report();
    expect(walks).toBeGreaterThan(1);
  });

  it('forces a re-walk on demand', async () => {
    const { root, vaultDir } = await vaultFixture();
    let walks = 0;
    const scanner = scannerFor(root, vaultDir, {
      vaults: () => {
        walks += 1;
        return [{ vaultId: 'v1', dir: vaultDir }];
      },
    });
    await scanner.report();
    await scanner.report({ force: true });
    expect(walks).toBe(2);
  });

  it('keeps last-known-good figures when a refresh throws', async () => {
    const { root, vaultDir } = await vaultFixture();
    let fail = false;
    const scanner = scannerFor(root, vaultDir, {
      ttlMs: 0,
      vaults: () => {
        if (fail) throw new Error('registry is mid-remount');
        return [{ vaultId: 'v1', dir: vaultDir }];
      },
    });
    const first = await scanner.report();
    expect(first.totalBytes).toBeGreaterThan(0);

    fail = true;
    const second = await scanner.report({ force: true });
    // Blanking a number that was true a moment ago is worse than showing it
    // with an explanation attached.
    expect(second.totalBytes).toBe(first.totalBytes);
    expect(second.error).toContain('mid-remount');
  });

  it('reports zero rather than throwing when statfs is unavailable', async () => {
    const { root, vaultDir } = await vaultFixture();
    const report = await scannerFor(root, vaultDir, { statfs: () => null }).report();
    expect(report.disk).toBeNull();
    expect(report.totalBytes).toBeGreaterThan(0);
  });
});
