import { tempDirSync } from '@centraid/test-kit/temp-dir';
/*
 * `buildDiagnosticsBundle` — document shape, vault file sizing (cheap
 * statSync, no CAS walk), the redaction contract (issue #351), and the
 * per-table size breakdown + inline-body violation scan (issue #367 §E1/E4).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test } from 'vitest';
import { bootstrapVault, openVaultDb, type VaultDb } from '@centraid/vault';
import { buildDiagnosticsBundle } from './gateway-diagnostics.ts';
import { GatewayLogStore } from './gateway-log-store.ts';
import { HealthRegistry } from './health-registry.ts';
import type { VaultPlane } from './vault-plane.ts';
import type { VaultRegistry } from './vault-registry.ts';

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = tempDirSync('gateway-diagnostics-');
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** A registry stub carrying only what `buildDiagnosticsBundle` touches. */
function fakeVaultRegistry(planes: VaultPlane[]): VaultRegistry {
  return { planesList: () => planes } as unknown as VaultRegistry;
}

/** A plane stub carrying only `boot.vaultId` / `name` / `dir`. */
function fakePlane(vaultId: string, name: string, dir: string): VaultPlane {
  return { boot: { vaultId }, name, dir } as unknown as VaultPlane;
}

/** A plane stub that ALSO carries real, open vault/journal handles (§E1/E4). */
function fakePlaneWithDb(vaultId: string, name: string, dir: string, db: VaultDb): VaultPlane {
  return { boot: { vaultId }, name, dir, db } as unknown as VaultPlane;
}

test('assembles version, runtime, health, logs, and vault sizes', async () => {
  const vaultDir = makeTmpDir();
  fs.writeFileSync(path.join(vaultDir, 'vault.db'), Buffer.alloc(1234));
  fs.writeFileSync(path.join(vaultDir, 'journal.db'), Buffer.alloc(5678));
  // No -wal files written — those should read back as null, not throw.

  const health = new HealthRegistry();
  health.reportOk('vaults', '1 vault mounted');
  const logs = new GatewayLogStore();
  logs.append('info', 'boot');
  logs.append('warn', 'something noisy');

  const bundle = await buildDiagnosticsBundle({
    health,
    logs,
    vaults: fakeVaultRegistry([fakePlane('v1', 'Personal', vaultDir)]),
    config: { foo: 'bar' },
  });

  expect(bundle.gateway.version).toEqual(expect.any(String));
  expect(typeof bundle.gateway.schemaEpoch).toBe('number');
  expect(bundle.runtime.nodeVersion).toBe(process.version);
  expect(bundle.runtime.platform).toBe(os.platform());
  expect(bundle.health.status).toBe('ok');
  expect(bundle.logs.map((e) => e.message)).toEqual(['boot', 'something noisy']);
  expect(bundle.vaults).toEqual([
    {
      vaultId: 'v1',
      name: 'Personal',
      files: {
        vaultDbBytes: 1234,
        vaultDbWalBytes: null,
        journalDbBytes: 5678,
        journalDbWalBytes: null,
      },
    },
  ]);
  expect(bundle.config).toEqual({ foo: 'bar' });
  expect(typeof bundle.generatedAt).toBe('string');
});

test('the log tail is capped to logLimit, newest entries kept', async () => {
  const health = new HealthRegistry();
  const logs = new GatewayLogStore();
  for (let i = 1; i <= 10; i++) logs.append('info', `line ${i}`);

  const bundle = await buildDiagnosticsBundle({
    health,
    logs,
    vaults: fakeVaultRegistry([]),
    logLimit: 3,
  });

  expect(bundle.logs.map((e) => e.message)).toEqual(['line 8', 'line 9', 'line 10']);
});

test('reads statSync sizes without touching anything beyond the four DB files', async () => {
  const vaultDir = makeTmpDir();
  fs.writeFileSync(path.join(vaultDir, 'vault.db'), Buffer.alloc(10));
  fs.writeFileSync(path.join(vaultDir, 'vault.db-wal'), Buffer.alloc(20));
  fs.writeFileSync(path.join(vaultDir, 'journal.db'), Buffer.alloc(30));
  fs.writeFileSync(path.join(vaultDir, 'journal.db-wal'), Buffer.alloc(40));
  // A blob-CAS-shaped directory that a naive implementation might walk —
  // diagnostics must never touch it (statSync-only, per issue #351).
  fs.mkdirSync(path.join(vaultDir, 'blobs', 'aa'), { recursive: true });
  fs.writeFileSync(path.join(vaultDir, 'blobs', 'aa', 'huge-blob'), Buffer.alloc(100));

  const bundle = await buildDiagnosticsBundle({
    health: new HealthRegistry(),
    logs: new GatewayLogStore(),
    vaults: fakeVaultRegistry([fakePlane('v1', 'Personal', vaultDir)]),
  });

  expect(bundle.vaults[0]!.files).toEqual({
    vaultDbBytes: 10,
    vaultDbWalBytes: 20,
    journalDbBytes: 30,
    journalDbWalBytes: 40,
  });
});

test('redaction: secret-shaped keys never appear in the serialized bundle, however deep', async () => {
  const secretApiKey = 'sk-super-secret-diagnostics-test-value';
  const secretToken = 'bearer-token-should-never-leak';
  const config = {
    paths: { vaultDir: '/tmp/vault' },
    backup: {
      enabled: true,
      provider: {
        kind: 'remote',
        endpoint: 'https://api.example.com',
        apiKey: secretApiKey,
      },
    },
    nested: {
      deeper: {
        authToken: secretToken,
        harmless: 'this stays visible',
      },
    },
  };

  const bundle = await buildDiagnosticsBundle({
    health: new HealthRegistry(),
    logs: new GatewayLogStore(),
    vaults: fakeVaultRegistry([]),
    config,
  });

  const serialized = JSON.stringify(bundle);
  expect(serialized).not.toContain(secretApiKey);
  expect(serialized).not.toContain(secretToken);
  expect(serialized).toContain('this stays visible');
  expect(
    (bundle.config as { nested: { deeper: { authToken: string } } }).nested.deeper.authToken,
  ).toBe('[REDACTED]');
});

test('a plane stub with no `.db` (every test above) omits tableStats rather than throwing', async () => {
  const vaultDir = makeTmpDir();
  fs.writeFileSync(path.join(vaultDir, 'vault.db'), Buffer.alloc(1));
  fs.writeFileSync(path.join(vaultDir, 'journal.db'), Buffer.alloc(1));

  const bundle = await buildDiagnosticsBundle({
    health: new HealthRegistry(),
    logs: new GatewayLogStore(),
    vaults: fakeVaultRegistry([fakePlane('v1', 'Personal', vaultDir)]),
  });

  expect(bundle.vaults[0]!.tableStats).toBeUndefined();
});

test('a mounted vault with live handles gets a dbstat table breakdown and an inline-body violation scan', async () => {
  const vaultDir = makeTmpDir();
  const db = openVaultDb({ dir: vaultDir });
  bootstrapVault(db, { ownerName: 'Priya' });

  const bundle = await buildDiagnosticsBundle({
    health: new HealthRegistry(),
    logs: new GatewayLogStore(),
    vaults: fakeVaultRegistry([fakePlaneWithDb('v1', 'Personal', vaultDir, db)]),
  });

  const stats = bundle.vaults[0]!.tableStats;
  expect(stats).toBeDefined();
  expect(stats!.vaultDb.method).toBe('dbstat');
  expect(stats!.vaultDb.tables.length).toBeGreaterThan(0);
  expect(stats!.journalDb.method).toBe('dbstat');
  // A fresh vault has nothing over the inline-body budget.
  expect(stats!.inlineBodyViolations.total).toEqual({ count: 0, bytes: 0 });

  db.close();
});
