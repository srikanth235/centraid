/*
 * Coverage for the provider-usage poller (issue #367 §D1) against a REAL
 * in-process HTTP fake implementing just `GET /v1/backup/vaults/:id/usage`
 * (PROTOCOL.md § Usage) — same "fake mirrors the real gateway" philosophy
 * `remote-provider.test.ts` uses, scoped down to the one route this module
 * calls. No mocked `fetch`.
 */

import { afterEach, expect, test, vi } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { openStorageConnectionStore, type StorageConnectionStore } from './storage-connections.js';
import { StorageUsagePoller } from './storage-usage.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function tempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `storage-usage-${crypto.randomUUID()}-`));
  cleanups.push(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Minimal fake provider — one route, PROTOCOL.md's exact envelope + shape. */
function startFakeUsageServer(opts: {
  apiKey: string;
  targetId: string;
  usage: { backup?: unknown; cas?: unknown };
}): Promise<{ url: string; requestCount: () => number; close: () => Promise<void> }> {
  let requests = 0;
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${opts.apiKey}`) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'auth_expired', message: 'bad key' } }));
      return;
    }
    if (req.method === 'GET' && req.url === `/v1/backup/vaults/${opts.targetId}/usage`) {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: opts.usage }));
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'not_found', message: 'no route' } }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
      resolve({
        url: `http://127.0.0.1:${port}`,
        requestCount: () => requests,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

async function makeProviderConnection(
  store: StorageConnectionStore,
  baseUrl: string,
  apiKey: string,
  targetId: string,
): Promise<string> {
  const connection = await store.create({ kind: 'provider', name: 'Clawgnition', baseUrl, apiKey });
  await store.setTargetId(connection.id, targetId);
  return connection.id;
}

test('first read fetches inline and caches the report', async () => {
  const dir = await tempDir();
  const store = await openStorageConnectionStore(dir);
  const fake = await startFakeUsageServer({
    apiKey: 'sk-test',
    targetId: 'target-1',
    usage: {
      backup: { bytesStored: 1000, objectCount: 5, quotaBytes: 10_000, period: { start: 0, end: 1 } },
      cas: { bytesStored: 2000, objectCount: 9, quotaBytes: null, period: { start: 0, end: 1 } },
    },
  });
  const connectionId = await makeProviderConnection(store, fake.url, 'sk-test', 'target-1');

  const poller = new StorageUsagePoller({ storageConnections: store });
  const result = await poller.usageFor(connectionId);

  expect(result.providerReported?.backup?.bytesStored).toBe(1000);
  expect(result.providerReported?.backup?.quotaBytes).toBe(10_000);
  expect(result.providerReported?.cas?.quotaBytes).toBeNull();
  expect(result.fetchedAt).not.toBeNull();
  expect(fake.requestCount()).toBe(1);

  // Second read within the poll window is served from cache — no second request.
  const second = await poller.usageFor(connectionId);
  expect(second.providerReported?.backup?.bytesStored).toBe(1000);
  expect(fake.requestCount()).toBe(1);
});

test('stale-while-refresh: a read past pollIntervalMs returns the cached value immediately and refreshes in the background', async () => {
  const dir = await tempDir();
  const store = await openStorageConnectionStore(dir);
  const fake = await startFakeUsageServer({
    apiKey: 'sk-test',
    targetId: 'target-1',
    usage: { backup: { bytesStored: 500, objectCount: 1, quotaBytes: null, period: { start: 0, end: 1 } } },
  });
  const connectionId = await makeProviderConnection(store, fake.url, 'sk-test', 'target-1');

  let now = 0;
  const poller = new StorageUsagePoller({
    storageConnections: store,
    pollIntervalMs: 1000,
    now: () => now,
  });

  const first = await poller.usageFor(connectionId);
  expect(first.providerReported?.backup?.bytesStored).toBe(500);
  expect(fake.requestCount()).toBe(1);

  // Advance past the poll window — usageFor returns the STALE cached value
  // synchronously-ish (no await on the network) while a refresh fires.
  now = 5000;
  const stale = await poller.usageFor(connectionId);
  expect(stale.providerReported?.backup?.bytesStored).toBe(500); // still the old number, served instantly
  // Let the background refresh's microtasks/IO settle.
  await new Promise((r) => setTimeout(r, 50));
  expect(fake.requestCount()).toBe(2);
});

test('byo-s3 connections report null with no network call', async () => {
  const dir = await tempDir();
  const store = await openStorageConnectionStore(dir);
  const connection = await store.create({
    kind: 'byo-s3',
    name: 'My bucket',
    endpoint: 'https://s3.example.com',
    region: 'us-east-1',
    bucket: 'b',
    accessKeyId: 'ak',
    secretAccessKey: 'sk',
  });
  const poller = new StorageUsagePoller({ storageConnections: store });
  const result = await poller.usageFor(connection.id);
  expect(result.providerReported).toBeNull();
  expect(result.fetchedAt).toBeNull();
});

test('a provider connection with no target yet reports null with no network call', async () => {
  const dir = await tempDir();
  const store = await openStorageConnectionStore(dir);
  const connection = await store.create({
    kind: 'provider',
    name: 'Not attached yet',
    baseUrl: 'http://127.0.0.1:1', // would refuse if ever called
    apiKey: 'sk-test',
  });
  const poller = new StorageUsagePoller({ storageConnections: store });
  const result = await poller.usageFor(connection.id);
  expect(result.providerReported).toBeNull();
  expect(result.error).toBeUndefined();
});

test('a failed refresh keeps serving the last-known-good report with an error note', async () => {
  const dir = await tempDir();
  const store = await openStorageConnectionStore(dir);
  const fake = await startFakeUsageServer({
    apiKey: 'sk-test',
    targetId: 'target-1',
    usage: { backup: { bytesStored: 777, objectCount: 2, quotaBytes: null, period: { start: 0, end: 1 } } },
  });
  const connectionId = await makeProviderConnection(store, fake.url, 'sk-test', 'target-1');

  let now = 0;
  const poller = new StorageUsagePoller({ storageConnections: store, pollIntervalMs: 1000, now: () => now });
  const first = await poller.usageFor(connectionId);
  expect(first.providerReported?.backup?.bytesStored).toBe(777);

  await fake.close();
  now = 5000;
  await poller.usageFor(connectionId); // triggers the background refresh
  await new Promise((r) => setTimeout(r, 50));
  const afterFailedRefresh = await poller.usageFor(connectionId);
  expect(afterFailedRefresh.providerReported?.backup?.bytesStored).toBe(777); // last-known-good preserved
});

test('a wrong api key surfaces as an error without throwing out of usageFor', async () => {
  const dir = await tempDir();
  const store = await openStorageConnectionStore(dir);
  const fake = await startFakeUsageServer({
    apiKey: 'sk-correct',
    targetId: 'target-1',
    usage: { backup: { bytesStored: 1, objectCount: 1, quotaBytes: null, period: { start: 0, end: 1 } } },
  });
  const connectionId = await makeProviderConnection(store, fake.url, 'sk-wrong', 'target-1');
  const poller = new StorageUsagePoller({ storageConnections: store });
  const result = await poller.usageFor(connectionId);
  expect(result.providerReported).toBeNull();
  expect(result.error).toBeDefined();
});
