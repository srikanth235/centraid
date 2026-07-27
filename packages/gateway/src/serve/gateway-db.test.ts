import { tempDir } from '@centraid/test-kit/temp-dir';
import { aesGcmKeyProtector, KeyStore } from '@centraid/vault';
import { afterEach, expect, test } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { StorageConnectionStore } from '../backup/storage-connections.js';
import {
  darwinNetworkFileSystem,
  GatewayDatabase,
  GatewayLockError,
  parseDarwinFileSystemType,
} from './gateway-db.js';
import { openVaultRegistry } from './vault-registry.js';

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
    'erase_intents',
    'founding_ticket_reservations',
    'gateway_meta',
    'prefs',
    'recovery_kit',
    'storage_connections',
    'storage_limits',
    'tickets',
    'web_sessions',
  ]);
  expect(tables).not.toContain('vaults');
  expect(
    (
      gateway.db.prepare('PRAGMA table_info(founding_ticket_reservations)').all() as Array<{
        name: string;
      }>
    ).map((column) => column.name),
  ).toContain('pending_vault_ids_json');
  expect(existsSync(path.join(dir, 'gateway.db-shm'))).toBe(false);
  for (const retired of [
    'prefs.json',
    'devices.json',
    'tickets.json',
    'recovery-kit.json',
    'backup.json',
    'endpoint.json',
    'gateway.lease',
    'gateway.lock.db',
    'profile.json',
    'gateway.status.json',
    'gateway.ownership.json',
    'token.bin',
    'storage',
    'backup',
  ]) {
    expect(existsSync(path.join(dir, retired)), retired).toBe(false);
  }
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
      enrollment_id, endpoint_id, vault_id, label, role, remember_device, added_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    'enrollment',
    'endpoint',
    'vault',
    'Laptop',
    'write',
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
  const endpointSecret = Buffer.alloc(32, 0x11);
  const connectionsSecret = Buffer.alloc(32, 0x33);
  const keyringSecret = Buffer.alloc(32, 0x44);
  keyStore.store('endpoint-key.bin', endpointSecret);
  keyStore.store('connections.sealkey', connectionsSecret);
  keyStore.store('keyring.key', keyringSecret);
  const registry = openVaultRegistry({
    rootDir: path.join(dir, 'vault'),
    cacheRootDir: path.join(dir, 'cache'),
    keyStore,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    ownerName: 'Priya',
  });
  const vault = registry.create('Protected vault');
  const plane = registry.get(vault.vaultId)!;
  expect(
    plane.gateway.invoke(plane.ownerCredential, {
      command: 'locker.add_item',
      input: {
        type: 'login',
        title: 'example.com',
        username: 'priya',
        password: 'real-sealed-row',
      },
      purpose: 'dpv:ServiceProvision',
    }).status,
  ).toBe('executed');
  const vaultSecret = keyStore.export(`${vault.vaultId}.sealkey`);
  expect(vaultSecret).toHaveLength(32);
  registry.stop();
  const secrets = [endpointSecret, vaultSecret!, connectionsSecret, keyringSecret];
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

/*
 * Issue #568 item I. The previous darwin probe shelled out to
 * `/usr/bin/stat -f '%T'`, which is the `ls -F` type indicator, not a
 * filesystem type — it exited 0 with a value nothing could match and, worse,
 * suppressed the `statfsSync` fallback. These cover the replacement, which
 * reads the mount table's `f_fstypename` the way `/sbin/mount` prints it.
 */
const MOUNT_TABLE = [
  '/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)',
  '/dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse)',
  '//guest@nas._smb._tcp.local/media on /Volumes/media (smbfs, nodev, nosuid, mounted by srikanth)',
  'nas:/export/backups on /Volumes/backups (nfs, nodev, nosuid)',
  'map auto_home on /System/Volumes/Data/home (autofs, automounted, nobrowse)',
].join('\n');

test('darwin filesystem detection reads the mount table type, longest mount point wins', () => {
  expect(parseDarwinFileSystemType(MOUNT_TABLE, '/Users/srikanth/gw-data')).toBe('apfs');
  expect(parseDarwinFileSystemType(MOUNT_TABLE, '/Volumes/media/gw-data')).toBe('smbfs');
  expect(parseDarwinFileSystemType(MOUNT_TABLE, '/Volumes/backups')).toBe('nfs');
  // `/System/Volumes/Data/home` must not lose to the shorter `/` or
  // `/System/Volumes/Data` prefixes.
  expect(parseDarwinFileSystemType(MOUNT_TABLE, '/System/Volumes/Data/home/x')).toBe('autofs');
});

test('darwin network detection answers true on remote mounts and false on local ones', () => {
  const read = (): string => MOUNT_TABLE;
  expect(darwinNetworkFileSystem('/Volumes/media/gw-data', read)).toBe(true);
  expect(darwinNetworkFileSystem('/Volumes/backups/gw-data', read)).toBe(true);
  expect(darwinNetworkFileSystem('/Users/srikanth/gw-data', read)).toBe(false);
});

test('an unreadable mount table stays undefined so the statfs fallback still runs', () => {
  expect(darwinNetworkFileSystem('/anywhere', () => undefined)).toBeUndefined();
  // A path under no listed mount point is equally inconclusive.
  expect(darwinNetworkFileSystem('relative/not/absolute', () => MOUNT_TABLE)).toBeUndefined();
});
