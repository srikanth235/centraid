import { randomUUID } from 'node:crypto';
import http from 'node:http';
import {
  paginateAuditEvents,
  paginateInventory,
  validateProviderPolicy,
} from '../provider-observability.js';
import {
  BackupProviderError,
  type ProviderAuditEvent,
  type ProviderAuditQuery,
  type ProviderInventoryObject,
  type ProviderInventoryQuery,
  type ProviderPolicy,
  type SnapshotRow,
  type StoreClass,
} from '../provider.js';
import { S3TestServer } from './s3-test-server.js';

const API_KEY = 'test-bearer-token';
const BUCKET = 'test-bucket';
const SOFT_DELETE_WINDOW_DAYS = 14;

interface FakeTarget {
  id: string;
  name: string;
  status: 'active' | 'deleted';
  currentGeneration: number;
  deletedAt: string | null;
}

export interface FakeProviderServer {
  url: string;
  apiKey: string;
  s3: S3TestServer;
  close: () => Promise<void>;
  seedPruneEvent: (targetId: string) => Promise<void>;
}

function jsonBody(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ data }));
}

function errorBody(
  res: http.ServerResponse,
  status: number,
  code: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  const type =
    code === 'conflict_generation' || code === 'purge_pending'
      ? 'conflict_error'
      : 'invalid_request_error';
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type, code, ...(details ? { details } : {}) } }));
}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function numberParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  return raw === null ? undefined : Number(raw);
}

/** Reusable in-process implementation of every advertised provider route. */
export async function startFakeProviderServer(): Promise<FakeProviderServer> {
  const targets = new Map<string, FakeTarget>();
  const snapshots = new Map<string, SnapshotRow[]>();
  const idempotency = new Map<string, Map<string, SnapshotRow>>();
  const nextSeq = new Map<string, number>();
  const policies = new Map<string, ProviderPolicy>();
  const events = new Map<string, ProviderAuditEvent[]>();
  const s3 = await S3TestServer.start({ listPageSize: 2 });

  function appendEvent(
    targetId: string,
    kind: ProviderAuditEvent['kind'],
    detail: Record<string, unknown>,
  ): void {
    (events.get(targetId) ?? []).push({ at: Math.floor(Date.now() / 1000), kind, detail });
  }

  function usageFor(targetId: string) {
    const prefix = `u/${targetId}/backup/`;
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
      meteredAt: Math.floor(Date.now() / 1000),
    };
  }

  function usageReportFor(targetId: string, store: StoreClass) {
    const prefix = `u/${targetId}/${store}/`;
    let bytesStored = 0;
    let objectCount = 0;
    for (const key of s3.listDirect(BUCKET, prefix)) {
      bytesStored += s3.getObjectDirect(BUCKET, key)?.length ?? 0;
      objectCount++;
    }
    return {
      bytesStored,
      objectCount,
      quotaBytes: null,
      period: { start: 0, end: Math.floor(Date.now() / 1000) },
    };
  }

  function inventoryFor(target: FakeTarget, query: ProviderInventoryQuery) {
    const prefix = `u/${target.id}/${query.store}/`;
    const rows: ProviderInventoryObject[] = s3.listDirect(BUCKET, prefix).map((fullKey) => {
      const metadata = s3.getObjectMetadataDirect(BUCKET, fullKey)!;
      return {
        key: fullKey.slice(prefix.length),
        sizeBytes: metadata.size,
        etagOrHash: metadata.etagOrHash,
        storedAt: metadata.storedAt,
        storageClass: metadata.storageClass,
        state: target.status === 'active' ? 'live' : 'soft-deleted',
      };
    });
    return paginateInventory(rows, query);
  }

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      if (err instanceof BackupProviderError) {
        errorBody(res, err.status, err.code, err.message, err.details);
        return;
      }
      errorBody(res, 502, 'provider_error', err instanceof Error ? err.message : String(err));
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const route = url.pathname;
    if (req.headers.authorization !== `Bearer ${API_KEY}`) {
      errorBody(res, 401, 'auth_expired', 'invalid or missing bearer token');
      return;
    }
    if (req.method === 'GET' && route === '/v1/backup/provider') {
      jsonBody(res, 200, {
        protocol: ['centraid-storage-provider/1'],
        dataPlane: 's3',
        capabilities: ['backup', 'cas', 'usage', 'policy', 'inventory', 'audit'],
        maxCredentialTtlSeconds: 86400,
        purgeAuthTier: 'interactive',
        backup: {
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
        },
      });
      return;
    }
    if (req.method === 'POST' && route === '/v1/backup/vaults') {
      const body = (await readJsonBody(req)) as { name: string };
      const id = randomUUID();
      targets.set(id, {
        id,
        name: body.name,
        status: 'active',
        currentGeneration: 0,
        deletedAt: null,
      });
      snapshots.set(id, []);
      idempotency.set(id, new Map());
      nextSeq.set(id, 1);
      events.set(id, []);
      jsonBody(res, 200, { id });
      return;
    }
    if (req.method === 'GET' && route === '/v1/backup/vaults') {
      jsonBody(res, 200, {
        accountStatus: 'ok',
        vaults: [...targets.values()].map((target) => ({
          ...target,
          usage: usageFor(target.id),
        })),
      });
      return;
    }

    const match = /^\/v1\/backup\/vaults\/([^/]+)(.*)$/.exec(route);
    if (!match) return errorBody(res, 404, 'not_found', `no route for ${route}`);
    const targetId = match[1]!;
    const rest = match[2]!;
    const target = targets.get(targetId);
    if (!target) return errorBody(res, 404, 'not_found', `unknown target "${targetId}"`);

    if (req.method === 'POST' && rest === '/credentials') {
      const body = (await readJsonBody(req)) as {
        ttlSeconds: number;
        mode: 'read' | 'read-write';
        store: StoreClass;
      };
      const expiresAt = Math.floor(Date.now() / 1000) + body.ttlSeconds;
      appendEvent(targetId, 'credential-issued', {
        store: body.store,
        mode: body.mode,
        expiresAt,
      });
      jsonBody(res, 200, {
        endpoint: s3.url,
        region: 'auto',
        bucket: BUCKET,
        prefix: `u/${targetId}/${body.store}/`,
        store: body.store,
        accessKeyId: 'AKIAFAKETEST',
        secretAccessKey: 'fakeSecretKeyValue',
        sessionToken: 'fakeSessionToken',
        expiresAt,
        mode: body.mode,
      });
      return;
    }
    if (req.method === 'GET' && rest === '/usage') {
      jsonBody(res, 200, {
        backup: usageReportFor(targetId, 'backup'),
        cas: usageReportFor(targetId, 'cas'),
      });
      return;
    }
    if (rest === '/policy') {
      if (req.method === 'PUT') {
        const policy = {
          ...validateProviderPolicy(await readJsonBody(req)),
          declaredAt: Math.floor(Date.now() / 1000),
        };
        policies.set(targetId, policy);
        appendEvent(targetId, 'policy-changed', { policy });
        return jsonBody(res, 200, policy);
      }
      if (req.method === 'GET') {
        const policy = policies.get(targetId);
        if (!policy) return errorBody(res, 404, 'not_found', 'no policy declared');
        return jsonBody(res, 200, policy);
      }
    }
    if (req.method === 'GET' && rest === '/inventory') {
      const store = url.searchParams.get('store');
      if (store !== 'backup' && store !== 'cas') {
        return errorBody(res, 400, 'invalid_request', 'store must be backup or cas');
      }
      return jsonBody(
        res,
        200,
        inventoryFor(target, {
          store,
          cursor: url.searchParams.get('cursor') ?? undefined,
          since: numberParam(url, 'since'),
          limit: numberParam(url, 'limit'),
        }),
      );
    }
    if (req.method === 'GET' && rest === '/events') {
      const query: ProviderAuditQuery = {
        cursor: url.searchParams.get('cursor') ?? undefined,
        since: numberParam(url, 'since'),
        limit: numberParam(url, 'limit'),
      };
      return jsonBody(res, 200, paginateAuditEvents(events.get(targetId) ?? [], query));
    }
    if (req.method === 'POST' && rest === '/snapshots') {
      const reg = (await readJsonBody(req)) as Parameters<
        import('../provider.js').BackupProvider['registerSnapshot']
      >[1];
      const cached = idempotency.get(targetId)!.get(reg.idempotencyKey);
      if (cached) return jsonBody(res, 200, cached);
      if (reg.generation < target.currentGeneration) {
        return errorBody(res, 409, 'conflict_generation', 'stale generation', {
          currentGeneration: target.currentGeneration,
        });
      }
      const rows = snapshots.get(targetId)!;
      const seq = nextSeq.get(targetId) ?? 1;
      const row: SnapshotRow = {
        ...reg,
        seq,
        prevManifestHash: rows[0]?.manifestHash ?? null,
        createdAt: Math.floor(Date.now() / 1000),
        prunedAt: null,
      };
      nextSeq.set(targetId, seq + 1);
      rows.unshift(row);
      target.currentGeneration = Math.max(target.currentGeneration, reg.generation);
      idempotency.get(targetId)!.set(reg.idempotencyKey, row);
      return jsonBody(res, 200, row);
    }
    if (req.method === 'GET' && rest === '/snapshots') {
      const rows = snapshots.get(targetId) ?? [];
      return jsonBody(
        res,
        200,
        url.searchParams.get('includePruned') === '1'
          ? rows
          : rows.filter((row) => row.prunedAt === null),
      );
    }
    const seqMatch = /^\/snapshots\/(\d+)$/.exec(rest);
    if (req.method === 'GET' && seqMatch) {
      const seq = Number(seqMatch[1]);
      const row = (snapshots.get(targetId) ?? []).find((item) => item.seq === seq);
      return row
        ? jsonBody(res, 200, row)
        : errorBody(res, 404, 'not_found', `unknown snapshot seq ${seq}`);
    }
    if (req.method === 'DELETE' && rest === '') {
      target.status = 'deleted';
      target.deletedAt = new Date().toISOString();
      appendEvent(targetId, 'soft-delete', { targetId });
      return jsonBody(res, 200, {});
    }
    if (req.method === 'POST' && rest === '/undelete') {
      target.status = 'active';
      target.deletedAt = null;
      appendEvent(targetId, 'undelete', { targetId });
      return jsonBody(res, 200, {});
    }
    if (req.method === 'POST' && rest === '/purge') {
      return errorBody(res, 403, 'interactive_auth_required', 'purge requires interactive auth');
    }
    return errorBody(res, 404, 'not_found', `no route for ${req.method} ${route}`);
  }

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`,
    apiKey: API_KEY,
    s3,
    seedPruneEvent: async (targetId) => {
      if (!targets.has(targetId)) throw new Error(`unknown target "${targetId}"`);
      appendEvent(targetId, 'prune', {
        store: 'backup',
        keys: ['manifests/pruned.json'],
        retentionRung: 'daily',
      });
    },
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await s3.close();
    },
  };
}
