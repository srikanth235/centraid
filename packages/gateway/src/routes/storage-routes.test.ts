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
import { bootstrapVault, openVaultDb, type VaultDb } from '@centraid/vault';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import type { VaultPlane } from '../serve/vault-plane.js';
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

/**
 * Minimal fake storage provider — serves just the discovery document
 * (`GET /v1/storage/provider`, PROTOCOL.md) the home-profile gate (#436 §1)
 * reads on create/test. `home: true` advertises the `home` profile with the
 * full capability bundle; `home: false` advertises neither, so the gate
 * rejects it with `provider_not_home_profile`.
 */
function startFakeProviderServer(opts: { apiKey: string; home: boolean }): Promise<string> {
  const server = http.createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${opts.apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { type: 'invalid_request_error', code: 'auth_expired', message: 'bad key' },
        }),
      );
      return;
    }
    if (req.method === 'GET' && req.url === '/v1/storage/provider') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: {
            protocol: ['centraid-storage-provider/1'],
            dataPlane: 's3',
            capabilities: opts.home
              ? ['backup', 'cas', 'derived', 'usage', 'policy', 'inventory', 'audit']
              : ['backup', 'cas'],
            ...(opts.home ? { profiles: ['home'] } : {}),
            maxCredentialTtlSeconds: 3600,
            purgeAuthTier: 'interactive',
            backup: {
              softDeleteWindowDays: 30,
              retention: {
                kind: 'ladder',
                keepAllDays: 7,
                dailyDays: 30,
                weeklyDays: 90,
                neverPruneNewest: true,
              },
              restoreCostClass: 'free-egress',
              objectLock: true,
              conditionalWrites: true,
            },
            storageClasses: ['STANDARD', 'STANDARD_IA'],
          },
        }),
      );
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { type: 'invalid_request_error', code: 'not_found', message: 'no route' },
      }),
    );
  });
  servers.push(server);
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

function fakeVaults(): VaultRegistry {
  return { planesList: () => [] } as unknown as VaultRegistry;
}

/** A real in-memory VaultDb (migrated schema + a live BlobCustody/BlobCache),
 *  wrapped as the minimal `VaultPlane` shape the status route reads — enough
 *  to exercise the real `custodyState*`/`metrics()` reads without a disk. */
function planeFromDb(name: string, vaultId: string, db: VaultDb): VaultPlane {
  return { name, boot: { vaultId }, db } as unknown as VaultPlane;
}

function vaultsFrom(planes: VaultPlane[]): VaultRegistry {
  return { planesList: () => planes } as unknown as VaultRegistry;
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

  const apiKey = 'sk-provider-super-secret-value';
  const provider = await startFakeProviderServer({ apiKey, home: true });
  const body = { kind: 'provider', name: 'Clawgnition home', baseUrl: provider, apiKey };

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
  expect(forcedJson.connection.kind).toBe('provider');
  expect(forcedJson.connection.baseUrl).toBe(provider);
  // Never a secret field, sealed or not.
  const asString = JSON.stringify(forcedJson.connection);
  expect(asString).not.toContain(apiKey);
  expect('apiKey' in forcedJson.connection).toBe(false);

  // The sealed sidecar on disk never carries the plaintext api key either.
  const rawFile = await fs.readFile(path.join(dir, 'connections.json'), 'utf8');
  expect(rawFile).not.toContain(apiKey);
});

test('confirmed recovery kit: create proceeds without force; list/get/patch/delete round-trip', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  await recoveryKit.confirm();
  const onConnectionsChanged = vi.fn(async () => undefined);
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
      onConnectionsChanged,
    }),
  );

  const apiKey = 'sk-provider-secret';
  const provider = await startFakeProviderServer({ apiKey, home: true });
  const created = await fetch(`${base}/centraid/_gateway/storage/connections`, {
    method: 'POST',
    body: JSON.stringify({
      kind: 'provider',
      name: 'Clawgnition',
      baseUrl: provider,
      apiKey,
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
  expect(onConnectionsChanged).toHaveBeenCalledTimes(3);
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

test('GET status/events exposes the authenticated custody completion stream', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  const controller = new AbortController();
  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: fakeVaults(),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );

  const res = await fetch(`${base}/centraid/_gateway/storage/status/events`, {
    signal: controller.signal,
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  const first = await res.body!.getReader().read();
  controller.abort();
  expect(new TextDecoder().decode(first.value)).toContain('event: custody\ndata: {"vaults":[]}');
});

test('create is rejected when the provider does not advertise the home profile (#436 §1)', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  await recoveryKit.confirm();
  const apiKey = 'sk-not-home';
  const provider = await startFakeProviderServer({ apiKey, home: false });
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
    body: JSON.stringify({ kind: 'provider', name: 'not-home', baseUrl: provider, apiKey }),
  });
  expect(res.status).toBe(400);
  const json = (await res.json()) as { error: string; message: string };
  expect(json.error).toBe('provider_not_home_profile');
  expect(json.message).toMatch(/home/);
  // Nothing persisted — the gate runs before create.
  expect((await storageConnections.list()).length).toBe(0);
});

test('only one home connection can exist at a time (#436 §7)', async () => {
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
  const create = async (name: string) => {
    const apiKey = `sk-${name}`;
    const provider = await startFakeProviderServer({ apiKey, home: true });
    return fetch(`${base}/centraid/_gateway/storage/connections`, {
      method: 'POST',
      body: JSON.stringify({ kind: 'provider', name, baseUrl: provider, apiKey }),
    });
  };
  expect((await create('first')).status).toBe(201);
  const second = await create('second');
  expect(second.status).toBe(409);
  const json = (await second.json()) as { error: string; message: string };
  expect(json.error).toBe('already_exists');
  expect(json.message).toMatch(/only one home connection/);
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

test('GET usage: a provider connection with no target yet reports providerReported: null with localReplicatedBytes 0 (no vaults mounted)', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);
  await recoveryKit.confirm();
  const apiKey = 'sk-usage';
  const provider = await startFakeProviderServer({ apiKey, home: true });
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
    body: JSON.stringify({ kind: 'provider', name: 'My home', baseUrl: provider, apiKey }),
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
  expect(body.connections[0]?.kind).toBe('provider');
  expect(body.connections[0]?.providerReported).toBeNull();
  expect(body.connections[0]?.localReplicatedBytes).toBe(0);
});

// ── Bounded storage-tier metrics on GET status (issue #405 §7) ─────────────
// The `cache` block makes tier health visible: spool vs. budget, the hit-rate
// counters, bytes served local vs. remote, evictions and backpressure.

interface StatusCacheDTO {
  spoolBytes: number;
  budgetBytes: number | null;
  localHits: number;
  readThroughs: number;
  rangedRemoteReads: number;
  bytesServedLocal: number;
  bytesServedRemote: number;
  evictedBlobs: number;
  evictedBytes: number;
  backpressureEvents: number;
}

test('GET status carries the #405 §7 cache block per vault; in-memory vault reports an unlimited (null) budget with live spool + hit counters', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);

  const db = openVaultDb();
  cleanups.push(() => db.close());
  const blob = Buffer.from('cache-metrics-fixture-blob');
  const { sha256 } = db.blobs.ingestSync(blob);
  db.blobs.getSync(sha256); // one local hit — bumps localHits + bytesServedLocal

  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: vaultsFrom([planeFromDb('Main', 'v1', db)]),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );

  const res = await fetch(`${base}/centraid/_gateway/storage/status`);
  expect(res.status).toBe(200);
  const out = (await res.json()) as { vaults: { vaultId: string; cache: StatusCacheDTO }[] };
  const cache = out.vaults[0]?.cache;
  expect(cache).toBeDefined();
  // In-memory vault has no volume to measure ⇒ unlimited ⇒ null (never the
  // Number.MAX_SAFE_INTEGER sentinel on the wire).
  expect(cache?.budgetBytes).toBeNull();
  expect(cache?.spoolBytes).toBe(blob.length);
  expect(cache?.localHits).toBe(1);
  expect(cache?.bytesServedLocal).toBe(blob.length);
  expect(cache?.readThroughs).toBe(0);
  expect(cache?.rangedRemoteReads).toBe(0);
  expect(cache?.bytesServedRemote).toBe(0);
  expect(cache?.evictedBlobs).toBe(0);
  expect(cache?.backpressureEvents).toBe(0);
});

test('GET status surfaces a real (non-null) budget when blob_cache.budgetBytes is set explicitly', async () => {
  const dir = await tempDir();
  const storageConnections = await openStorageConnectionStore(dir);
  const recoveryKit = new RecoveryKitStateStore(dir);

  const db = openVaultDb();
  cleanups.push(() => db.close());
  // The explicit budget lives in `core_vault.settings_json`, which only exists
  // after bootstrap — mint the vault, then set the operator's budget (it wins
  // over the derived one, issue #405 §3).
  bootstrapVault(db, { ownerName: 'Tester' });
  db.vault
    .prepare('UPDATE core_vault SET settings_json = ?')
    .run(JSON.stringify({ blob_cache: { budgetBytes: 1_000_000 } }));

  const base = await startHandlerServer(
    makeStorageRouteHandler({
      storageConnections,
      recoveryKit,
      vaults: vaultsFrom([planeFromDb('Main', 'v1', db)]),
      storageUsage: new StorageUsagePoller({ storageConnections }),
    }),
  );

  const res = await fetch(`${base}/centraid/_gateway/storage/status`);
  const out = (await res.json()) as { vaults: { cache: StatusCacheDTO }[] };
  expect(out.vaults[0]?.cache.budgetBytes).toBe(1_000_000);
});
