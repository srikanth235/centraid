import { afterEach, describe, expect, test } from 'vitest';
import { providerConformanceCases, type ConformanceHarness } from './conformance.js';
import { BackupProviderError } from './provider.js';
import { RemoteBackupProvider } from './remote-provider.js';
import { S3ObjectStore } from './s3-store.js';
import {
  startFakeProviderServer,
  type FakeProviderServer,
} from './testing/fake-provider-server.js';

const BUCKET = 'test-bucket';
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(): Promise<{
  gateway: FakeProviderServer;
  provider: RemoteBackupProvider;
}> {
  const gateway = await startFakeProviderServer();
  cleanups.push(gateway.close);
  const provider = new RemoteBackupProvider({ baseUrl: gateway.url, apiKey: gateway.apiKey });
  return { gateway, provider };
}

describe('RemoteBackupProvider against the fake gateway', () => {
  test('auth: missing/wrong bearer is rejected with auth_expired', async () => {
    const { gateway } = await fixture();
    const bad = new RemoteBackupProvider({ baseUrl: gateway.url, apiKey: 'wrong-key' });
    await expect(bad.capabilities()).rejects.toMatchObject({ code: 'auth_expired', status: 401 });
  });

  test('envelope: capabilities unwraps the {data} envelope', async () => {
    const { provider } = await fixture();
    const caps = await provider.capabilities();
    expect(caps.protocol).toContain('centraid-storage-provider/1');
    expect(caps.purgeAuthTier).toBe('interactive');
    expect(caps.capabilities).toEqual(['backup', 'cas', 'usage', 'policy', 'inventory', 'audit']);
    expect(caps.backup?.retention).toEqual({
      kind: 'ladder',
      keepAllDays: 7,
      dailyDays: 30,
      weeklyDays: 365,
      neverPruneNewest: true,
    });
  });

  test('error mapping: not_found target maps to BackupProviderError with the right code/status', async () => {
    const { provider } = await fixture();
    await expect(provider.getSnapshot('unknown-target', 1)).rejects.toMatchObject({
      code: 'not_found',
      status: 404,
    });
    const err = await provider.getSnapshot('unknown-target', 1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BackupProviderError);
  });

  test('generation fencing surfaces 409 conflict_generation with currentGeneration', async () => {
    const { provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    await provider.registerSnapshot(targetId, {
      idempotencyKey: 'a',
      manifestKey: 'manifests/a.json',
      manifestHash: 'a'.repeat(64),
      totalBytes: 1,
      objectCount: 1,
      generation: 3,
      format: 'centraid-snapshot/2',
      appMeta: {},
    });
    await expect(
      provider.registerSnapshot(targetId, {
        idempotencyKey: 'b',
        manifestKey: 'manifests/b.json',
        manifestHash: 'b'.repeat(64),
        totalBytes: 1,
        objectCount: 1,
        generation: 1,
        format: 'centraid-snapshot/2',
        appMeta: {},
      }),
    ).rejects.toMatchObject({ code: 'conflict_generation', details: { currentGeneration: 3 } });
  });

  test('credential modes round-trip through the fake S3 data plane', async () => {
    const { provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    const rw = await provider.openDataPlane(targetId, 'backup', 'read-write');
    await rw.put('chunks/x', new TextEncoder().encode('remote hello'));
    expect(new TextDecoder().decode(await rw.get('chunks/x'))).toBe('remote hello');

    const ro = await provider.openDataPlane(targetId, 'backup', 'read');
    expect(new TextDecoder().decode(await ro.get('chunks/x'))).toBe('remote hello');
    await expect(ro.put('chunks/y', new Uint8Array(1))).rejects.toThrow();
  });

  test('policy, inventory, and audit routes preserve their wire envelopes', async () => {
    const { provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 'observable' });
    const policy = await provider.putPolicy(targetId, {
      rpoSeconds: 60,
      snapshotIntervalHours: 24,
      verifyEveryDays: 7,
      casAck: 'receipt',
    });
    expect(await provider.getPolicy(targetId)).toEqual(policy);

    const store = await provider.openDataPlane(targetId, 'cas', 'read-write');
    await store.put('blobs/a', new Uint8Array([1, 2, 3]));
    const inventory = await provider.listInventory(targetId, { store: 'cas', limit: 1 });
    expect(inventory.objects).toMatchObject([{ key: 'blobs/a', sizeBytes: 3, state: 'live' }]);

    const audit = await provider.listEvents(targetId);
    expect(audit.events.map((event) => event.kind)).toContain('policy-changed');
    expect(audit.events.map((event) => event.kind)).toContain('credential-issued');
  });

  test('SigV4 PUT/GET requests carry authorization and payload hashes', async () => {
    const { gateway, provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    const store = await provider.openDataPlane(targetId, 'backup', 'read-write');
    await store.put('chunks/sigtest', new Uint8Array([1, 2, 3]));
    await store.get('chunks/sigtest');

    const putReq = gateway.s3.requests.find((request) => request.method === 'PUT');
    const getReq = gateway.s3.requests.find(
      (request) => request.method === 'GET' && !request.path.includes('list-type'),
    );
    for (const request of [putReq!, getReq!]) {
      expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKETEST\//);
      expect(request.headers.authorization).toMatch(/Signature=[0-9a-f]{64}/);
      expect(request.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(request.headers['x-amz-security-token']).toBe('fakeSessionToken');
    }
  });

  test('S3ObjectStore.list paginates against the fake and returns every key', async () => {
    const { provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    const store = await provider.openDataPlane(targetId, 'backup', 'read-write');
    for (let i = 0; i < 5; i++) await store.put(`chunks/p${i}`, new Uint8Array([i]));
    const keys: string[] = [];
    for await (const object of store.list('chunks/')) keys.push(object.key);
    expect(keys.sort()).toEqual(['chunks/p0', 'chunks/p1', 'chunks/p2', 'chunks/p3', 'chunks/p4']);
  });

  test('purge surfaces interactive_auth_required (403)', async () => {
    const { provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    await expect(provider.purgeTarget(targetId)).rejects.toMatchObject({
      code: 'interactive_auth_required',
      status: 403,
    });
  });

  test('S3ObjectStore refreshes an expiring grant', async () => {
    const { gateway } = await fixture();
    let refreshCount = 0;
    const grant = {
      endpoint: gateway.s3.url,
      region: 'auto',
      bucket: BUCKET,
      prefix: 'u/manual-test/backup/',
      store: 'backup' as const,
      accessKeyId: 'AKIAFAKETEST',
      secretAccessKey: 'fakeSecretKeyValue',
      sessionToken: 'fakeSessionToken',
      expiresAt: Math.floor(Date.now() / 1000) - 10,
      mode: 'read-write' as const,
    };
    const store = new S3ObjectStore(grant, {
      refreshGrant: async () => {
        refreshCount++;
        return { ...grant, expiresAt: Math.floor(Date.now() / 1000) + 3600 };
      },
    });
    await store.put('chunks/refresh-test', new Uint8Array([9]));
    expect(refreshCount).toBeGreaterThanOrEqual(1);
  });
});

describe('full conformance run against RemoteBackupProvider + fake gateway', () => {
  async function makeHarness(): Promise<ConformanceHarness> {
    const gateway = await startFakeProviderServer();
    return {
      provider: new RemoteBackupProvider({ baseUrl: gateway.url, apiKey: gateway.apiKey }),
      cleanup: gateway.close,
      seedPruneEvent: gateway.seedPruneEvent,
    };
  }

  for (const testCase of providerConformanceCases(makeHarness)) {
    test(testCase.name, testCase.run);
  }
});
