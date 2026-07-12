import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createVaultIntegrityHealthProbe } from './vault-integrity-health.js';

const dbs: DatabaseSync[] = [];
function memDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE t (x INTEGER)');
  db.exec('INSERT INTO t VALUES (1)');
  dbs.push(db);
  return db;
}

afterEach(() => {
  while (dbs.length > 0) dbs.pop()?.close();
});

describe('createVaultIntegrityHealthProbe', () => {
  it('reports ok with no vaults mounted', async () => {
    const probe = createVaultIntegrityHealthProbe({ vaults: () => [] });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('no vaults mounted');
  });

  it('reports ok for a healthy vault + journal pair', async () => {
    const probe = createVaultIntegrityHealthProbe({
      vaults: () => [{ vaultId: 'vault-aaaaaaaa', vault: memDb(), journal: memDb() }],
    });
    const result = await probe();
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('1 vault clean');
  });

  it('reports error with the failure lines when quick_check itself throws', async () => {
    const vault = memDb();
    // Simulate a corrupted-file read path — quick_check throwing outright
    // is as real a failure mode as it returning non-'ok' rows.
    vault.prepare = () => {
      throw new Error('database disk image is malformed');
    };
    const probe = createVaultIntegrityHealthProbe({
      vaults: () => [{ vaultId: 'vault-bbbbbbbb', vault, journal: memDb() }],
    });
    const result = await probe();
    expect(result.status).toBe('error');
    expect(result.detail).toContain('vault-bb');
    expect(result.detail).toContain('malformed');
  });

  it('does not re-run quick_check within the interval — reuses the cached result', async () => {
    let checks = 0;
    const vault = memDb();
    const originalPrepare = vault.prepare.bind(vault);
    vault.prepare = ((sql: string) => {
      if (sql === 'PRAGMA quick_check') checks += 1;
      return originalPrepare(sql);
    }) as typeof vault.prepare;

    let now = 0;
    const probe = createVaultIntegrityHealthProbe({
      vaults: () => [{ vaultId: 'vault-cccccccc', vault, journal: memDb() }],
      intervalMs: 60_000,
      now: () => now,
    });

    await probe();
    expect(checks).toBe(1);
    now = 30_000; // still inside the interval
    await probe();
    expect(checks).toBe(1);
    now = 70_000; // past the interval — re-checks
    await probe();
    expect(checks).toBe(2);
  });

  it('keeps reporting a stale failure until the next scheduled re-check', async () => {
    const vault = memDb();
    vault.prepare = () => {
      throw new Error('database disk image is malformed');
    };
    let now = 0;
    const probe = createVaultIntegrityHealthProbe({
      vaults: () => [{ vaultId: 'vault-dddddddd', vault, journal: memDb() }],
      intervalMs: 60_000,
      now: () => now,
    });
    expect((await probe()).status).toBe('error');
    now = 30_000;
    // Cached failure still surfaces even without re-running the scan.
    expect((await probe()).status).toBe('error');
  });
});
