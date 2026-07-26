import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, expect, test, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { KeyStore } from '@centraid/vault';
import { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { daemonLayoutFor } from '../cli/paths.js';
import { EnrollmentStore } from '../serve/enrollment-store.js';
import { GatewayDatabase } from '../serve/gateway-db.js';
import { runWithVaultContext } from '../serve/vault-context.js';
import { openVaultRegistry } from '../serve/vault-registry.js';
import { WebControlSessionStore } from '../serve/web-session-store.js';
import { recoverPendingVaultErases } from '../serve/erase-recovery.js';
import { makeVaultRouteHandler } from './vault-routes.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function treeShape(root: string, relative = ''): Promise<string[]> {
  const dir = path.join(root, relative);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const rows: string[] = [];
  for (const entry of entries) {
    const child = path.join(relative, entry.name);
    rows.push(`${entry.isDirectory() ? 'd' : 'f'}:${child}`);
    if (entry.isDirectory()) rows.push(...(await treeShape(root, child)));
  }
  return rows.sort();
}

async function markKitVerified(store: RecoveryKitStateStore): Promise<void> {
  await store.begin('test-kit-fingerprint');
  expect(await store.verify('test-kit-fingerprint')).toBeTruthy();
}

test('erasing the last vault cascades gateway state, destroys its DEK, and preserves gateway identity', async () => {
  const dataDir = await tempDir('vault-erase-');
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const layout = daemonLayoutFor(dataDir);
  const database = GatewayDatabase.open(dataDir);
  cleanups.push(() => database.close());
  const keys = new KeyStore(layout.keysDir);
  keys.store('endpoint-key.bin', randomBytes(32));
  const endpointBefore = keys.export('endpoint-key.bin');
  const vaultlessShape = await treeShape(dataDir);

  const registry = openVaultRegistry({
    rootDir: layout.vaultDir,
    cacheRootDir: layout.cacheDir,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  cleanups.push(() => registry.stop());
  const vault = registry.create('Family');
  keys.store(`${vault.vaultId}.sealkey.next`, randomBytes(32));

  const enrollments = EnrollmentStore.open(database);
  enrollments.enroll({
    endpointId: 'owner-device',
    vaultId: vault.vaultId,
    label: 'Owner laptop',
    trust: 'owner',
  });
  WebControlSessionStore.open(database).establish({
    tokenHash: 'session-hash',
    vaultId: vault.vaultId,
    deviceKey: 'owner-device',
    shellOrigin: 'http://127.0.0.1:4173',
  });
  database.run(
    `INSERT INTO tickets (
      ticket_id, kind, secret_hash, vault_id, trust, created_at, expires_at
    ) VALUES (?, 'enroll', ?, ?, 'full', ?, ?)`,
    'pending-pair',
    'secret-hash',
    vault.vaultId,
    new Date(0).toISOString(),
    Date.now() + 60_000,
  );
  database.run(
    `INSERT INTO backup_targets (target_id, vault_id, config_json, updated_at)
     VALUES (?, ?, ?, ?)`,
    'backup-target',
    vault.vaultId,
    '{}',
    new Date(0).toISOString(),
  );
  database.run(
    `INSERT INTO cas_reconciliations (vault_id, state_json, updated_at)
     VALUES (?, ?, ?)`,
    vault.vaultId,
    '{}',
    new Date(0).toISOString(),
  );
  const recoveryKit = new RecoveryKitStateStore(database);
  await markKitVerified(recoveryKit);
  const fenceVaultForErase = vi.fn(async (vaultId: string) => {
    expect(vaultId).toBe(vault.vaultId);
    expect(registry.get(vaultId)).toBeTruthy();
  });

  const handler = makeVaultRouteHandler(registry, {
    enrollments,
    gatewayDatabase: database,
    keys,
    recoveryKit,
    fenceVaultForErase,
  });
  const server = http.createServer((req, res) => {
    void runWithVaultContext({ vaultId: vault.vaultId, deviceKey: 'owner-device' }, () =>
      handler(req, res),
    );
  });
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${base}/centraid/_vault/vaults:erase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Family' }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    ok: true,
    erasedVaultId: vault.vaultId,
    status: 'uninitialized',
  });
  expect(fenceVaultForErase).toHaveBeenCalledOnce();

  expect(registry.isFresh()).toBe(true);
  expect(enrollments.list()).toEqual([]);
  expect(database.db.prepare('SELECT COUNT(*) AS count FROM web_sessions').get()).toEqual({
    count: 0,
  });
  const tables = database.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const columns = database.db.prepare(`PRAGMA table_info("${name}")`).all() as Array<{
      name: string;
    }>;
    if (!columns.some((column) => column.name === 'vault_id')) continue;
    expect(
      database.db
        .prepare(`SELECT COUNT(*) AS count FROM "${name}" WHERE vault_id = ?`)
        .get(vault.vaultId),
      `${name} retained the erased vault id`,
    ).toEqual({ count: 0 });
  }
  expect(keys.export(`${vault.vaultId}.sealkey`)).toBeNull();
  expect(keys.export(`${vault.vaultId}.sealkey.next`)).toBeNull();
  expect(keys.export('endpoint-key.bin')).toEqual(endpointBefore);
  expect(await recoveryKit.status()).toMatchObject({ confirmedAt: expect.any(Number) });
  expect(await treeShape(dataDir)).toEqual(vaultlessShape);
});

test('a crash after erase state commit is completed before the next registry mount', async () => {
  const dataDir = await tempDir('vault-erase-crash-');
  cleanups.push(() => fs.rm(dataDir, { recursive: true, force: true }));
  const layout = daemonLayoutFor(dataDir);
  const database = GatewayDatabase.open(dataDir);
  cleanups.push(() => database.close());
  const keys = new KeyStore(layout.keysDir);
  const registry = openVaultRegistry({
    rootDir: layout.vaultDir,
    cacheRootDir: layout.cacheDir,
    keyStore: keys,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
  });
  const vault = registry.create('Crash test');
  const enrollments = EnrollmentStore.open(database);
  enrollments.enroll({
    endpointId: 'owner-device',
    vaultId: vault.vaultId,
    label: 'Owner laptop',
    trust: 'owner',
  });
  const recoveryKit = new RecoveryKitStateStore(database);
  await markKitVerified(recoveryKit);
  const handler = makeVaultRouteHandler(registry, {
    enrollments,
    gatewayDatabase: database,
    keys,
    recoveryKit,
    afterEraseStateCommitted: () => {
      throw new Error('injected crash after state commit');
    },
  });
  const server = http.createServer((req, res) => {
    void runWithVaultContext({ vaultId: vault.vaultId, deviceKey: 'owner-device' }, () =>
      handler(req, res),
    );
  });
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const response = await fetch(`${base}/centraid/_vault/vaults:erase`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Crash test' }),
  });
  expect(response.status).toBe(500);
  expect(enrollments.list()).toEqual([]);
  expect(database.db.prepare('SELECT vault_id FROM erase_intents').all()).toEqual([
    { vault_id: vault.vaultId },
  ]);
  await expect(
    fs.access(path.join(layout.vaultDir, vault.vaultId, 'vault.db')),
  ).resolves.toBeUndefined();

  registry.stop();
  expect(
    recoverPendingVaultErases({
      gatewayDatabase: database,
      vaultRoot: layout.vaultDir,
      cacheRoot: layout.cacheDir,
      keys,
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    }),
  ).toEqual([vault.vaultId]);
  expect(database.db.prepare('SELECT COUNT(*) AS count FROM erase_intents').get()).toEqual({
    count: 0,
  });
  await expect(fs.access(path.join(layout.vaultDir, vault.vaultId))).rejects.toThrow();
  expect(keys.export(`${vault.vaultId}.sealkey`)).toBeNull();
});
