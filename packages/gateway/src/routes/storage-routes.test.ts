/*
 * HTTP-level coverage for the storage-connection routes (issue #367 §C1):
 * CRUD against a REAL `StorageConnectionStore` (real sealed JSON file on
 * disk, real AES-256-GCM), the recovery-kit confirmation gate + `force`
 * override (§C10), and the per-vault status shape (§C7).
 */

import { afterEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import { openStorageConnectionStore } from '../backup/storage-connections.js';
import { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { StorageUsagePoller } from '../backup/storage-usage.js';
import { makeStorageRouteHandler } from './storage-routes.js';

const servers: http.Server[] = [];
const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) server.close();
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

function startHandlerServer(handler: RouteHandler): Promise<string> {
  const server = http.createServer((req, res) => {
    void handler(req, res).then((owned) => {
      if (!owned) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `storage-routes-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

function fakeVaults(): VaultRegistry {
  return { planesList: () => [] } as unknown as VaultRegistry;
}

test('POST create refuses without a confirmed recovery kit; {force:true} bypasses; connection never carries secrets back', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );

  const body = {
    kind: 'byo-s3',
    name: 'My R2 bucket',
    endpoint: 'https://example.r2.cloudflarestorage.com',
    region: 'auto',
    bucket: 'my-bucket',
    accessKeyId: 'AKIA_SECRET',
    secretAccessKey: 'super-secret-value',
  };

  const refused = await fetch(`${base}/centraid/_gateway/storage/connections`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  expect(refused.status).toBe(409);
  const refusedJson = (await refused.json()) as { error: string; recoveryKitConfirmed: boolean };
  expect(refusedJson.error).toBe('recovery_kit_not_confirmed');
  expect(refusedJson.recoveryKitConfirmed).toBe(false);
  expect((await storageConnections.list()).length).toBe(0);

  const forced = await fetch(`${base}/centraid/_gateway/storage/connections`, {
    method: 'POST',
    body: JSON.stringify({ ...body, force: true }),
  });
  expect(forced.status).toBe(201);
  const forcedJson = (await forced.json()) as {
    connection: Record<string, unknown>;
    recoveryKitConfirmed: boolean;
  };
  expect(forcedJson.recoveryKitConfirmed).toBe(false); // still unconfirmed — force only bypassed the refusal
  expect(forcedJson.connection.kind).toBe('byo-s3');
  expect(forcedJson.connection.endpoint).toBe(body.endpoint);
  // Never a secret field, sealed or not.
  const asString = JSON.stringify(forcedJson.connection);
  expect(asString).not.toContain('super-secret-value');
  expect(asString).not.toContain('AKIA_SECRET');
  expect('accessKeyId' in forcedJson.connection).toBe(false);
  expect('secretAccessKey' in forcedJson.connection).toBe(false);

  // The sealed sidecar on disk never carries the plaintext secret either.
  const rawFile = await fs.readFile(path.join(dir, 'connections.json'), 'utf8');
  expect(rawFile).not.toContain('super-secret-value');
  expect(rawFile).not.toContain('AKIA_SECRET');
});

test('confirmed recovery kit: create proceeds without force; list/get/patch/delete round-trip', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  await recoveryKit.confirm();
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );

  const created = await fetch(`${base}/centraid/_gateway/storage/connections`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'provider',
      name: 'Clawgnition',
      baseUrl: 'https://api.example.com',
      apiKey: 'sk-provider-secret',
    }),
  });
  expect(created.status).toBe(201);
  const { connection } = (await created.json()) as { connection: { id: string } };

  const list = await fetch(`${base}/centraid/_gateway/storage/connections`);
  expect(((await list.json()) as { connections: unknown[] }).connections.length).toBe(1);

  const got = await fetch(`${base}/centraid/_gateway/storage/connections/${connection.id}`);
  expect(got.status).toBe(200);

  const patched = await fetch(`${base}/centraid/_gateway/storage/connections/${connection.id}`, {
    method: 'PATCH',
    body: JSON.stringify({ name: 'Clawgnition (renamed)' }),
  });
  expect(patched.status).toBe(200);
  const patchedJson = (await patched.json()) as { connection: { name: string } };
  expect(patchedJson.connection.name).toBe('Clawgnition (renamed)');

  const deleted = await fetch(`${base}/centraid/_gateway/storage/connections/${connection.id}`, {
    method: 'DELETE',
  });
  expect(deleted.status).toBe(200);
  expect((await deleted.json()) as { ok: boolean }).toEqual({ ok: true });

  const goneAfterDelete = await fetch(
    `${base}/centraid/_gateway/storage/connections/${connection.id}`,
  );
  expect(goneAfterDelete.status).toBe(404);
});

test('DELETE an unknown connection 404s', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );
  const res = await fetch(`${base}/centraid/_gateway/storage/connections/does-not-exist`, {
    method: 'DELETE',
  });
  expect(res.status).toBe(404);
});

test('GET status answers per-vault shape even with zero mounted vaults', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );
  const res = await fetch(`${base}/centraid/_gateway/storage/status`);
  expect(res.status).toBe(200);
  expect((await res.json()) as { vaults: unknown[] }).toEqual({ vaults: [] });
});

test('BYO S3 cannot claim backup support because it has no registry, retention, or fencing plane', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );
  const res = await fetch(`${base}/centraid/_gateway/storage/connections`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'byo-s3',
      name: 'backup-only',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'bucket',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
      uses: ['backup'],
    }),
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as { message: string }).message).toMatch(/CAS replication only/);
});

test('only one provider backup destination can be active', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  await recoveryKit.confirm();
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );
  const create = (name: string) =>
    fetch(`${base}/centraid/_gateway/storage/connections`, {
      method: 'POST',
      body: JSON.stringify({
        kind: 'provider',
        name,
        baseUrl: `https://${name}.example.com`,
        apiKey: `sk-${name}`,
        uses: ['backup'],
      }),
    });
  expect((await create('first')).status).toBe(201);
  const second = await create('second');
  expect(second.status).toBe(400);
  expect(((await second.json()) as { message: string }).message).toMatch(/only one backup/);
});

test('GET usage answers an empty list with zero connections', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );
  const res = await fetch(`${base}/centraid/_gateway/storage/usage`);
  expect(res.status).toBe(200);
  expect((await res.json()) as { connections: unknown[] }).toEqual({ connections: [] });
});

test('GET usage: a byo-s3 connection reports providerReported: null with localReplicatedBytes 0 (no vaults mounted)', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  await recoveryKit.confirm();
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );
  await fetch(`${base}/centraid/_gateway/storage/connections`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'byo-s3',
      name: 'My bucket',
      endpoint: 'https://s3.example.com',
      region: 'us-east-1',
      bucket: 'bucket',
      accessKeyId: 'ak',
      secretAccessKey: 'sk',
    }),
  });
  const res = await fetch(`${base}/centraid/_gateway/storage/usage`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    connections: {
      connectionId: string;
      kind: string;
      providerReported: unknown;
      localReplicatedBytes: number;
    }[];
  };
  expect(body.connections.length).toBe(1);
  expect(body.connections[0]?.kind).toBe('byo-s3');
  expect(body.connections[0]?.providerReported).toBeNull();
  expect(body.connections[0]?.localReplicatedBytes).toBe(0);
});
