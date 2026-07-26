import { tempDir } from '@centraid/test-kit/temp-dir';
import { aesGcmKeyProtector, KeyStore } from '@centraid/vault';
import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { StorageConnectionStore } from '../backup/storage-connections.js';
import { GatewayDatabase, GatewayLockError } from './gateway-db.js';

const opened: GatewayDatabase[] = [];
afterEach(() => {
  while (opened.length > 0) opened.pop()?.close();
});

test('installs the full vaultless schema without a vault catalog or shm sidecar', async () => {
  const dir = await tempDir();
  const gateway = GatewayDatabase.open(dir);
  opened.push(gateway);

  const tables = (
    gateway.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
  expect(tables).toEqual([
    'backup_targets',
    'cas_reconciliations',
    'devices',
    'gateway_meta',
    'prefs',
    'recovery_kit',
    'storage_connections',
    'storage_limits',
    'tickets',
    'web_sessions',
  ]);
  expect(tables).not.toContain('vaults');
  expect(existsSync(path.join(dir, 'gateway.db-shm'))).toBe(false);
});

test('the gateway database itself is the exclusive lifetime lock', async () => {
  const dir = await tempDir();
  const first = GatewayDatabase.open(dir, { lock: 'exclusive' });
  opened.push(first);

  expect(
    (
      first.db.prepare('PRAGMA locking_mode').get() as {
        locking_mode: string;
      }
    ).locking_mode,
  ).toBe('exclusive');
  expect(() => GatewayDatabase.open(dir, { lock: 'exclusive' })).toThrow(GatewayLockError);
  expect(existsSync(path.join(dir, 'gateway.lock.db'))).toBe(false);
  expect(existsSync(path.join(dir, 'gateway.db-shm'))).toBe(false);

  first.close();
  opened.pop();
  const afterStop = new DatabaseSync(path.join(dir, 'gateway.db'), { readOnly: true });
  expect(afterStop.prepare("SELECT value FROM gateway_meta WHERE key = 'schema'").get()).toEqual({
    value: '1',
  });
  afterStop.close();
});

test('device deletion cascades its durable browser sessions', async () => {
  const dir = await tempDir();
  const gateway = GatewayDatabase.open(dir);
  opened.push(gateway);
  gateway.run(
    `INSERT INTO devices (
      enrollment_id, endpoint_id, vault_id, label, trust, remember_device, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'enrollment',
    'endpoint',
    'vault',
    'Laptop',
    'full',
    1,
    new Date(0).toISOString(),
  );
  gateway.run(
    `INSERT INTO web_sessions (
      token_hash, vault_id, device_key, shell_origin, created_at, expires_at, last_used_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'abc',
    'vault',
    'endpoint',
    'https://app.centraid.dev',
    new Date(0).toISOString(),
    100,
    0,
  );

  gateway.run('DELETE FROM devices WHERE enrollment_id = ?', 'enrollment');

  expect(gateway.db.prepare('SELECT count(*) AS n FROM web_sessions').get()).toEqual({ n: 0 });
});

test('the real gateway tree and every database table contain no raw or base64 key bytes', async () => {
  const dir = await tempDir();
  const gateway = GatewayDatabase.open(dir);
  opened.push(gateway);
  const keyStore = new KeyStore(path.join(dir, 'keys'), {
    protector: aesGcmKeyProtector(Buffer.alloc(32, 0xa5)),
  });
  const secrets = [
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x22),
    Buffer.alloc(32, 0x33),
    Buffer.alloc(32, 0x44),
  ];
  keyStore.store('endpoint.key', secrets[0]!);
  keyStore.store('vault-a.sealkey', secrets[1]!);
  keyStore.store('connections.sealkey', secrets[2]!);
  keyStore.store('keyring.key', secrets[3]!);
  const connections = await StorageConnectionStore.open({ database: gateway, keyStore });
  await connections.create({
    kind: 'provider',
    name: 'Encrypted provider',
    baseUrl: 'https://storage.example.test',
    apiKey: 'provider-credential-not-a-key-store-secret',
  });

  const tables = gateway.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
    .all() as Array<{ name: string }>;
  for (const { name } of tables) {
    const rows = gateway.db.prepare(`SELECT * FROM "${name}"`).all() as Array<
      Record<string, unknown>
    >;
    const bytes = Buffer.from(
      JSON.stringify(rows, (_key, value) =>
        Buffer.isBuffer(value) ? value.toString('base64') : value,
      ),
    );
    for (const secret of secrets) {
      expect(bytes.includes(secret)).toBe(false);
      expect(bytes.toString('utf8')).not.toContain(secret.toString('base64'));
    }
  }

  const files = readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath, entry.name));
  expect(files).toContain(path.join(dir, 'gateway.db'));
  for (const file of files) {
    const bytes = readFileSync(file);
    for (const secret of secrets) {
      expect(bytes.includes(secret)).toBe(false);
      expect(bytes.toString('utf8')).not.toContain(secret.toString('base64'));
    }
  }
});
