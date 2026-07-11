import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { afterEach, describe, expect, test } from 'vitest';
import { providerConformanceCases, type ConformanceHarness } from './conformance.js';
import { BackupProviderError } from './provider.js';
import { RemoteBackupProvider } from './remote-provider.js';
import { S3ObjectStore } from './s3-store.js';
import { S3TestServer } from './testing/s3-test-server.js';

/*
 * An in-process `node:http` fake that mirrors PROTOCOL.md's routes verbatim
 * — "the fake mirrors the real gateway" (this is the reference conformance
 * philosophy: a provider is graded by running against the exact same
 * `RemoteBackupProvider` client any real gateway would talk to). Every
 * handler below is commented with the PROTOCOL.md section it implements.
 * The control plane runs its own `node:http` server; the data plane is a
 * separate `S3TestServer` instance (shared with interop-clawgnition.test.ts)
 * — real providers point credential grants at a genuine, separately-hosted
 * S3-compatible service, so splitting the two here mirrors that shape
 * instead of quietly cheating by sharing one port.
 */

const API_KEY = 'test-bearer-token';
const BUCKET = 'test-bucket';
const SOFT_DELETE_WINDOW_DAYS = 14;

interface FakeTarget {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  currentGeneration: number;
  deletedAt: string | null;
  purgedAt: string | null;
}

interface FakeRow {
  seq: number;
  manifestKey: string;
  manifestHash: string;
  prevManifestHash: string | null;
  totalBytes: number;
  objectCount: number;
  generation: number;
  format: string;
  appMeta: Record<string, string>;
  /** Unix epoch seconds — Clawgnition emits epoch-second integers on the wire. */
  createdAt: number;
  prunedAt: number | null;
}

interface FakeGateway {
  url: string;
  apiKey: string;
  s3: S3TestServer;
  close: () => Promise<void>;
  /** Purge auth tier the fake enforces — always 'interactive' per PROTOCOL.md, exposed for clarity. */
  purgeAuthTier: 'interactive';
}

function jsonBody(res: http.ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify({ data });
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(body);
}

function errorBody(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  // Mirrors Clawgnition's real envelope, e.g. for a stale generation:
  // {"error":{"message":"…","type":"conflict_error","code":"conflict_generation",
  //  "details":{"currentGeneration":5}}} — clients branch on `code` (and read
  // `details`), never on `type`, but the fake still emits the real type string.
  const type =
    code === 'conflict_generation' || code === 'purge_pending'
      ? 'conflict_error'
      : 'invalid_request_error';
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      error: { message, type, code, ...(details ? { details } : {}) },
    }),
  );
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw.length > 0 ? JSON.parse(raw) : {};
}

async function startFakeGateway(): Promise<FakeGateway> {
  const targets = new Map<string, FakeTarget>();
  const snapshots = new Map<string, FakeRow[]>();
  const idempotency = new Map<string, Map<string, FakeRow>>();
  const nextSeq = new Map<string, number>();
  // Small page size (2) — deliberately exercises S3ObjectStore.list's
  // pagination, same as before this was extracted into S3TestServer.
  const s3 = await S3TestServer.start({ listPageSize: 2 });

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        await handle(req, res);
      } catch (err) {
        errorBody(res, 502, 'provider_error', err instanceof Error ? err.message : String(err));
      }
    })();
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const p = url.pathname;

    // --- Control plane (PROTOCOL.md § Routes) — all require bearer auth ---
    const auth = req.headers.authorization;
    if (auth !== `Bearer ${API_KEY}`) {
      errorBody(res, 401, 'auth_expired', 'invalid or missing bearer token');
      return;
    }

    // GET /v1/backup/provider — discovery/capabilities
    if (req.method === 'GET' && p === '/v1/backup/provider') {
      jsonBody(res, 200, {
        protocol: ['centraid-backup-provider/1'],
        dataPlane: 's3',
        maxCredentialTtlSeconds: 86400,
        softDeleteWindowDays: SOFT_DELETE_WINDOW_DAYS,
        retention: {
          kind: 'ladder',
          keepAllDays: 7,
          dailyDays: 30,
          weeklyDays: 365,
          neverPruneNewest: true,
        },
        restoreCostClass: 'metered-egress',
        objectLock: false,
        conditionalWrites: true,
        purgeAuthTier: 'interactive',
      });
      return;
    }

    // POST /v1/backup/vaults — create target
    if (req.method === 'POST' && p === '/v1/backup/vaults') {
      const body = (await readJsonBody(req)) as { name: string };
      const id = randomUUID();
      targets.set(id, {
        id,
        name: body.name,
        status: 'active',
        currentGeneration: 0,
        deletedAt: null,
        purgedAt: null,
      });
      snapshots.set(id, []);
      idempotency.set(id, new Map());
      nextSeq.set(id, 1);
      jsonBody(res, 200, { id });
      return;
    }

    // GET /v1/backup/vaults — list caller's targets + usage + accountStatus
    if (req.method === 'GET' && p === '/v1/backup/vaults') {
      const vaults = [...targets.values()].map((t) => ({
        id: t.id,
        name: t.name,
        status: t.status,
        currentGeneration: t.currentGeneration,
        usage: usageFor(t.id),
      }));
      jsonBody(res, 200, { accountStatus: 'ok', vaults });
      return;
    }

    const vaultMatch = /^\/v1\/backup\/vaults\/([^/]+)(.*)$/.exec(p);
    if (!vaultMatch) {
      errorBody(res, 404, 'not_found', `no route for ${p}`);
      return;
    }
    const targetId = vaultMatch[1] as string;
    const rest = vaultMatch[2] as string;
    const target = targets.get(targetId);
    if (!target) {
      errorBody(res, 404, 'not_found', `unknown target "${targetId}"`);
      return;
    }

    // POST /v1/backup/vaults/:id/credentials — issue grant
    if (req.method === 'POST' && rest === '/credentials') {
      const body = (await readJsonBody(req)) as { ttlSeconds: number; mode: 'read' | 'read-write' };
      jsonBody(res, 200, {
        endpoint: s3.url,
        bucket: BUCKET,
        prefix: `vaults/${targetId}/`,
        accessKeyId: 'AKIAFAKETEST',
        secretAccessKey: 'fakeSecretKeyValue',
        sessionToken: 'fakeSessionToken',
        expiresAt: Math.floor(Date.now() / 1000) + body.ttlSeconds,
        mode: body.mode,
      });
      return;
    }

    // POST /v1/backup/vaults/:id/snapshots — register
    if (req.method === 'POST' && rest === '/snapshots') {
      const reg = (await readJsonBody(req)) as {
        idempotencyKey: string;
        manifestKey: string;
        manifestHash: string;
        totalBytes: number;
        objectCount: number;
        generation: number;
        format: string;
        appMeta: Record<string, string>;
      };
      const idemMap = idempotency.get(targetId)!;
      const cached = idemMap.get(reg.idempotencyKey);
      if (cached) {
        jsonBody(res, 200, cached);
        return;
      }
      if (reg.generation < target.currentGeneration) {
        errorBody(res, 409, 'conflict_generation', 'stale generation', {
          currentGeneration: target.currentGeneration,
        });
        return;
      }
      const rows = snapshots.get(targetId)!;
      const seq = nextSeq.get(targetId) ?? 1;
      nextSeq.set(targetId, seq + 1);
      const row: FakeRow = {
        seq,
        manifestKey: reg.manifestKey,
        manifestHash: reg.manifestHash,
        prevManifestHash: rows[0]?.manifestHash ?? null,
        totalBytes: reg.totalBytes,
        objectCount: reg.objectCount,
        generation: reg.generation,
        format: reg.format,
        appMeta: reg.appMeta,
        createdAt: Math.floor(Date.now() / 1000), // epoch seconds, like Clawgnition
        prunedAt: null,
      };
      rows.unshift(row);
      target.currentGeneration = Math.max(target.currentGeneration, reg.generation);
      idemMap.set(reg.idempotencyKey, row);
      jsonBody(res, 200, row);
      return;
    }

    // GET /v1/backup/vaults/:id/snapshots — registry rows, newest first
    if (req.method === 'GET' && rest.startsWith('/snapshots') && !/\/snapshots\/\d+$/.test(rest)) {
      const includePruned = url.searchParams.get('includePruned') === '1';
      const rows = snapshots.get(targetId) ?? [];
      jsonBody(res, 200, includePruned ? rows : rows.filter((r) => r.prunedAt === null));
      return;
    }

    // GET /v1/backup/vaults/:id/snapshots/:seq — one registry row
    const seqMatch = /^\/snapshots\/(\d+)$/.exec(rest);
    if (req.method === 'GET' && seqMatch) {
      const seq = Number.parseInt(seqMatch[1] as string, 10);
      const row = (snapshots.get(targetId) ?? []).find((r) => r.seq === seq);
      if (!row) {
        errorBody(res, 404, 'not_found', `unknown snapshot seq ${seq}`);
        return;
      }
      jsonBody(res, 200, row);
      return;
    }

    // DELETE /v1/backup/vaults/:id — soft delete
    if (req.method === 'DELETE' && rest === '') {
      if (target.purgedAt) {
        errorBody(res, 409, 'purge_pending', 'target was purged');
        return;
      }
      target.status = 'deleted';
      target.deletedAt = new Date().toISOString();
      jsonBody(res, 200, {});
      return;
    }

    // POST /v1/backup/vaults/:id/undelete — cancel soft delete
    if (req.method === 'POST' && rest === '/undelete') {
      if (target.purgedAt) {
        errorBody(res, 404, 'undelete_window_expired', 'target was purged');
        return;
      }
      if (target.deletedAt) {
        const elapsed = Date.now() - new Date(target.deletedAt).getTime();
        if (elapsed > SOFT_DELETE_WINDOW_DAYS * 24 * 60 * 60 * 1000) {
          errorBody(res, 404, 'undelete_window_expired', 'window expired');
          return;
        }
      }
      target.status = 'active';
      target.deletedAt = null;
      jsonBody(res, 200, {});
      return;
    }

    // POST /v1/backup/vaults/:id/purge — MUST require the interactive tier;
    // an api-key-authed remote client always gets 403 (PROTOCOL.md § Auth).
    if (req.method === 'POST' && rest === '/purge') {
      errorBody(res, 403, 'interactive_auth_required', 'purge requires the interactive tier');
      return;
    }

    errorBody(res, 404, 'not_found', `no route for ${req.method} ${p}`);
  }

  function usageFor(targetId: string) {
    const prefix = `vaults/${targetId}/`;
    let storedBytes = 0;
    let objectCount = 0;
    for (const key of s3.listDirect(BUCKET, prefix)) {
      storedBytes += s3.getObjectDirect(BUCKET, key)?.length ?? 0;
      objectCount++;
    }
    return {
      storedBytes,
      objectCount,
      quotaBytes: 107374182400,
      meteredAt: Math.floor(Date.now() / 1000), // epoch seconds, like Clawgnition
    };
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey: API_KEY,
    s3,
    purgeAuthTier: 'interactive',
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await s3.close();
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()?.();
});

async function fixture(): Promise<{ gateway: FakeGateway; provider: RemoteBackupProvider }> {
  const gateway = await startFakeGateway();
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
    expect(caps.protocol).toContain('centraid-backup-provider/1');
    expect(caps.purgeAuthTier).toBe('interactive');
    expect(caps.retention).toEqual({
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
      format: 'centraid-snapshot/1',
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
        format: 'centraid-snapshot/1',
        appMeta: {},
      }),
    ).rejects.toMatchObject({ code: 'conflict_generation', details: { currentGeneration: 3 } });
  });

  test('credential modes: openDataPlane issues a grant per mode and it round-trips through the fake S3', async () => {
    const { provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    const rw = await provider.openDataPlane(targetId, 'read-write');
    await rw.put('chunks/x', new TextEncoder().encode('remote hello'));
    expect(new TextDecoder().decode(await rw.get('chunks/x'))).toBe('remote hello');

    const ro = await provider.openDataPlane(targetId, 'read');
    expect(new TextDecoder().decode(await ro.get('chunks/x'))).toBe('remote hello');
    await expect(ro.put('chunks/y', new Uint8Array(1))).rejects.toThrow();
  });

  test('SigV4 presence: PUT/GET requests carry an Authorization header shaped like AWS4-HMAC-SHA256 and x-amz-content-sha256', async () => {
    const { gateway, provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    const store = await provider.openDataPlane(targetId, 'read-write');
    await store.put('chunks/sigtest', new Uint8Array([1, 2, 3]));
    await store.get('chunks/sigtest');

    const putReq = gateway.s3.requests.find((r) => r.method === 'PUT');
    const getReq = gateway.s3.requests.find(
      (r) => r.method === 'GET' && !r.path.includes('list-type'),
    );
    expect(putReq).toBeDefined();
    expect(getReq).toBeDefined();
    for (const r of [putReq!, getReq!]) {
      const auth = r.headers.authorization;
      expect(auth).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIAFAKETEST\//);
      expect(auth).toMatch(/SignedHeaders=[a-z0-9;-]+/);
      expect(auth).toMatch(/Signature=[0-9a-f]{64}/);
      expect(r.headers['x-amz-content-sha256']).toMatch(/^[0-9a-f]{64}$/);
      expect(r.headers['x-amz-security-token']).toBe('fakeSessionToken');
    }
  });

  test('S3ObjectStore.list paginates against the fake (page size 2) and returns every key', async () => {
    const { gateway, provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    const store = await provider.openDataPlane(targetId, 'read-write');
    for (let i = 0; i < 5; i++) await store.put(`chunks/p${i}`, new Uint8Array([i]));
    const keys: string[] = [];
    for await (const obj of store.list('chunks/')) keys.push(obj.key);
    expect(keys.sort()).toEqual(['chunks/p0', 'chunks/p1', 'chunks/p2', 'chunks/p3', 'chunks/p4']);
    void gateway; // used above for s3.requests in other tests; keep symmetry
  });

  test('purge: remote provider surfaces interactive_auth_required (403) from the fake', async () => {
    const { provider } = await fixture();
    const { targetId } = await provider.createTarget({ label: 't' });
    await expect(provider.purgeTarget(targetId)).rejects.toMatchObject({
      code: 'interactive_auth_required',
      status: 403,
    });
  });

  test('S3ObjectStore refreshes an expiring grant via refreshGrant', async () => {
    const { gateway } = await fixture();
    let refreshCount = 0;
    const grant = {
      endpoint: gateway.s3.url,
      bucket: BUCKET,
      prefix: 'vaults/manual-test/',
      accessKeyId: 'AKIAFAKETEST',
      secretAccessKey: 'fakeSecretKeyValue',
      sessionToken: 'fakeSessionToken',
      expiresAt: Math.floor(Date.now() / 1000) - 10, // already "expired"
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
    const gateway = await startFakeGateway();
    return {
      provider: new RemoteBackupProvider({ baseUrl: gateway.url, apiKey: gateway.apiKey }),
      cleanup: gateway.close,
    };
  }

  for (const c of providerConformanceCases(makeHarness)) {
    test(c.name, c.run);
  }
});
