/*
 * Gateway-level storage-connection routes (issue #367 §C1) — CRUD over
 * `StorageConnectionStore` plus a real signed connectivity probe and a
 * per-vault replication-status read. Owner-facing, same bearer gate as
 * health/diagnostics/backup (mounted in `extraHandlers`, `build-gateway.ts`).
 * Section D (a later agent) builds the Settings UI screen against this
 * exact contract:
 *
 *   GET    /centraid/_gateway/storage/connections           — list (never carries secrets)
 *   POST   /centraid/_gateway/storage/connections            — create; body = CreateStorageConnectionInput
 *                                                              (+ optional {force: boolean}); 409
 *                                                              `recovery_kit_not_confirmed` when the
 *                                                              recovery kit hasn't been confirmed, unless
 *                                                              `force: true`; 400 `provider_not_home_profile`
 *                                                              when the provider isn't a home bundle (#436 §1);
 *                                                              409 `already_exists` if a home connection is
 *                                                              already configured (#436 §7)
 *   PATCH  /centraid/_gateway/storage/connections/<id>       — update; body = partial CreateStorageConnectionInput
 *   DELETE /centraid/_gateway/storage/connections/<id>       — delete
 *   POST   /centraid/_gateway/storage/connections/<id>/test  — real signed HEAD probe against a freshly granted
 *                                                              bucket, plus the provider's home-profile status
 *   GET    /centraid/_gateway/storage/status                 — per-vault replication progress: configured,
 *                                                              replicated/backlog (count + bytes), lastSweep,
 *                                                              throttleBytesPerSec, and (issue #405 §7) a
 *                                                              `cache` block making the bounded storage tier
 *                                                              visible: spool occupancy vs. budget
 *                                                              (`budgetBytes` is `null` when the tier is
 *                                                              unlimited — no disk to measure), the
 *                                                              process-lifetime hit-rate counters
 *                                                              (localHits / readThroughs / rangedRemoteReads —
 *                                                              raw counts, the UI derives the ratio), bytes
 *                                                              served local vs. remote, and eviction /
 *                                                              backpressure tallies. Counters reset on gateway
 *                                                              restart (process-lifetime, not durable).
 *   GET    /centraid/_gateway/storage/usage                  — per-connection usage (issue #367 §D1): a
 *                                                              provider-kind connection's cached
 *                                                              `centraid-storage-provider/1` usage report
 *                                                              alongside the locally-computed replicated byte
 *                                                              count (custody's own ground truth) — visible
 *                                                              drift between the two is an integrity signal,
 *                                                              not noise.
 *
 * Every response mirrors `StorageConnectionRecord` — `id, kind, name,
 * createdAt, updatedAt`, plus `baseUrl/targetId`. NEVER a credential field,
 * sealed or not.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  S3BlobStore,
  custodyStateByteCounts,
  custodyStateCounts,
  readBackupPolicy,
  readBlobStoreSettings,
} from '@centraid/vault';
import { requestCasGrant } from '@centraid/backup';
import type { RouteHandler } from '../serve/build-gateway.js';
import type { VaultRegistry } from '../serve/vault-registry.js';
import {
  StorageConnectionError,
  type CreateStorageConnectionInput,
  type StorageConnectionStore,
} from '../backup/storage-connections.js';
import {
  assertProviderHomeProfile,
  ensureProviderCasTarget,
  fetchProviderProfileStatus,
} from '../backup/storage-credentials.js';
import type { StorageUsagePoller } from '../backup/storage-usage.js';
import type { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { readJson, sendError, sendJson } from './route-helpers.js';

const CONNECTIONS_PATH = '/centraid/_gateway/storage/connections';
const STATUS_PATH = '/centraid/_gateway/storage/status';
const STATUS_EVENTS_PATH = '/centraid/_gateway/storage/status/events';
const USAGE_PATH = '/centraid/_gateway/storage/usage';

export interface StorageRouteDeps {
  storageConnections: StorageConnectionStore;
  recoveryKit: RecoveryKitStateStore;
  vaults: VaultRegistry;
  /** Provider usage cache (issue #367 §D1) — backs `GET storage/usage`. */
  storageUsage: StorageUsagePoller;
}

/** Sum of a connection's local custody bytes across every vault whose
 *  `blob_store.connectionId` points at it — `replicated` + `remote-only`
 *  (bytes custody has actually confirmed are off-box), deliberately NOT
 *  `local-only` (not yet replicated, so not a fair comparison against a
 *  provider's own "bytes stored" figure). */
function localReplicatedBytesByConnection(vaults: VaultRegistry): Map<string, number> {
  const totals = new Map<string, number>();
  for (const plane of vaults.planesList()) {
    const settings = readBlobStoreSettings(plane.db.vault);
    if (settings.kind !== 's3' || !settings.connectionId) continue;
    const bytes = custodyStateByteCounts(plane.db.vault);
    const replicated = bytes.replicated + bytes['remote-only'];
    totals.set(settings.connectionId, (totals.get(settings.connectionId) ?? 0) + replicated);
  }
  return totals;
}

function looksLikeCreateInput(body: Record<string, unknown>): boolean {
  return body.kind === 'provider' && typeof body.name === 'string';
}

function sendConnectionError(res: ServerResponse, err: unknown): true {
  if (err instanceof StorageConnectionError) {
    const status = err.code === 'not_found' ? 404 : err.code === 'already_exists' ? 409 : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  return sendError(res, err);
}

/** Real connectivity probe: one signed HEAD against a synthetic key — a 404 IS
 *  success (proves auth + reachability, not object existence). Also reads the
 *  provider's home-profile status (issue #436 §1) and folds it into the detail
 *  so the Test action shows whether this provider is a full home bundle. */
async function probeConnection(
  store: StorageConnectionStore,
  id: string,
): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const connection = await store.get(id);
  if (!connection) return { ok: false, error: `unknown storage connection "${id}"` };
  if (!connection.baseUrl) return { ok: false, error: 'connection is missing baseUrl' };
  const probeKey = '0'.repeat(64);
  try {
    const apiKey = await store.resolveProviderApiKey(id);
    // Home-profile status first: a non-home provider is a hard failure (a
    // home connection requires the full bundle), reported with the exact
    // missing capabilities rather than a generic reachability error.
    const profile = await fetchProviderProfileStatus(connection.baseUrl, apiKey);
    if (!profile.isHome) {
      const missing =
        profile.missingCapabilities.length > 0
          ? ` (missing ${profile.missingCapabilities.join(', ')})`
          : '';
      return {
        ok: false,
        error: `provider does not advertise the "home" profile${missing}`,
      };
    }
    const target = await ensureProviderCasTarget(store, id);
    const refreshed = await store.get(id);
    const grant = await requestCasGrant({
      baseUrl: connection.baseUrl,
      apiKey,
      targetId: refreshed!.targetId!,
      mode: 'read-write',
    });
    const s3 = new S3BlobStore({
      endpoint: target.endpoint,
      region: target.region,
      bucket: target.bucket,
      prefix: target.prefix,
      credentials: async () => ({
        accessKeyId: grant.accessKeyId,
        secretAccessKey: grant.secretAccessKey,
        ...(grant.sessionToken ? { sessionToken: grant.sessionToken } : {}),
      }),
    });
    await s3.stat(probeKey);
    return {
      ok: true,
      detail:
        'signed request reached the bucket and was accepted; provider advertises the home profile',
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

type StoragePlane = ReturnType<VaultRegistry['planesList']>[number];

function storageStatus(plane: StoragePlane) {
  const settings = readBlobStoreSettings(plane.db.vault);
  const policy = readBackupPolicy(plane.db.vault);
  const counts = custodyStateCounts(plane.db.vault);
  const bytes = custodyStateByteCounts(plane.db.vault);
  const sweep = plane.db.blobs.sweepStatus();
  const metrics = plane.db.blobs.metrics();
  const outbox = plane.db.blobTransfers.status();
  return {
    vaultId: plane.boot.vaultId,
    name: plane.name,
    configured: settings.kind === 's3',
    ...(settings.connectionId ? { connectionId: settings.connectionId } : {}),
    // `remote-only` is confirmed provider custody and therefore ackable;
    // pending-offsite/outbox is the only undrained state (#414).
    replicated: {
      count: counts.replicated + counts['remote-only'],
      bytes: bytes.replicated + bytes['remote-only'],
    },
    backlog: { count: outbox.pendingCount, bytes: outbox.pendingBytes },
    pendingOffsite: {
      count: outbox.pendingCount,
      bytes: outbox.pendingBytes,
      uploading: outbox.uploadingCount,
      lastError: outbox.lastError,
    },
    localOnly: { count: counts['local-only'], bytes: bytes['local-only'] },
    casAck: policy.casAck,
    outboxBudgetBytes: policy.outboxBudgetBytes,
    reservedHeadroomBytes: policy.reservedHeadroomBytes,
    lastSweep: {
      completedAt: sweep.lastCompletedAt,
      lastAttemptedAt: sweep.lastAttemptedAt,
      error: sweep.lastError,
      consecutiveFailures: sweep.consecutiveFailures,
    },
    ...(policy.throttleBytesPerSec ? { throttleBytesPerSec: policy.throttleBytesPerSec } : {}),
    cache: {
      spoolBytes: metrics.spoolBytes,
      budgetBytes: metrics.budgetBytes === Number.MAX_SAFE_INTEGER ? null : metrics.budgetBytes,
      localHits: metrics.localHits,
      readThroughs: metrics.readThroughs,
      rangedRemoteReads: metrics.rangedRemoteReads,
      bytesServedLocal: metrics.bytesServedLocal,
      bytesServedRemote: metrics.bytesServedRemote,
      evictedBlobs: metrics.evictedBlobs,
      evictedBytes: metrics.evictedBytes,
      backpressureEvents: metrics.backpressureEvents,
    },
  };
}

function streamStorageStatus(
  req: IncomingMessage,
  res: ServerResponse,
  planes: StoragePlane[],
): true {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const write = (): void => {
    if (!res.writableEnded) {
      res.write(
        `event: custody\ndata: ${JSON.stringify({ vaults: planes.map(storageStatus) })}\n\n`,
      );
    }
  };
  write();
  const unsubscribers = planes.map((plane) => plane.db.blobTransfers.subscribe(write));
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(': ping\n\n');
  }, 30_000);
  heartbeat.unref();
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on('close', cleanup);
  res.on('error', cleanup);
  return true;
}

export function makeStorageRouteHandler(deps: StorageRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');

    if (url.pathname === STATUS_PATH || url.pathname === STATUS_EVENTS_PATH) {
      if ((req.method ?? 'GET') !== 'GET') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
      }
      try {
        const planes = deps.vaults.planesList();
        if (url.pathname === STATUS_EVENTS_PATH) return streamStorageStatus(req, res, planes);
        const vaults = planes.map(storageStatus);
        return sendJson(res, 200, { vaults });
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (url.pathname === USAGE_PATH) {
      if ((req.method ?? 'GET') !== 'GET') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
      }
      try {
        const connections = await deps.storageConnections.list();
        const localBytes = localReplicatedBytesByConnection(deps.vaults);
        const results = await Promise.all(
          connections.map(async (connection) => {
            const usage =
              connection.kind === 'provider'
                ? await deps.storageUsage.usageFor(connection.id)
                : { providerReported: null, fetchedAt: null };
            return {
              connectionId: connection.id,
              kind: connection.kind,
              providerReported: usage.providerReported,
              localReplicatedBytes: localBytes.get(connection.id) ?? 0,
              ...(usage.fetchedAt ? { fetchedAt: usage.fetchedAt } : {}),
              ...('error' in usage && usage.error ? { error: usage.error } : {}),
            };
          }),
        );
        return sendJson(res, 200, { connections: results });
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (url.pathname === CONNECTIONS_PATH) {
      if ((req.method ?? 'GET') === 'GET') {
        try {
          return sendJson(res, 200, { connections: await deps.storageConnections.list() });
        } catch (err) {
          return sendError(res, err);
        }
      }
      if ((req.method ?? 'GET') === 'POST') {
        try {
          const raw = await readJson(req);
          const force = raw.force === true;
          if (!looksLikeCreateInput(raw)) {
            return sendJson(res, 400, {
              error: 'bad_request',
              message: 'body must carry {kind: "provider", name, baseUrl, apiKey}',
            });
          }
          const body = raw as unknown as CreateStorageConnectionInput;
          // Every connection is a home CAS bundle now (#436 §2/§7), so the
          // recovery-kit gate always applies before the first remote custody.
          const status = await deps.recoveryKit.status();
          const recoveryKitConfirmed = status.confirmedAt !== null;
          if (!recoveryKitConfirmed && !force) {
            return sendJson(res, 409, {
              error: 'recovery_kit_not_confirmed',
              recoveryKitConfirmed: false,
              message:
                'confirm you have exported and safely stored the recovery kit before enabling a ' +
                'remote storage tier (or resend with {force: true} to bypass)',
            });
          }
          // Home-profile gate (#436 §1): only a provider advertising the
          // `home` profile can back a Centraid home connection. Throws a typed
          // `provider_not_home_profile` StorageConnectionError → 400.
          await assertProviderHomeProfile(body.baseUrl, body.apiKey);
          const connection = await deps.storageConnections.create(body);
          return sendJson(res, 201, { connection, recoveryKitConfirmed });
        } catch (err) {
          return sendConnectionError(res, err);
        }
      }
      return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET, POST only' });
    }

    if (url.pathname.startsWith(`${CONNECTIONS_PATH}/`)) {
      const rest = url.pathname.slice(CONNECTIONS_PATH.length + 1);
      const segments = rest.split('/').filter(Boolean).map(decodeURIComponent);
      const id = segments[0];
      if (!id) return false;

      if (segments.length === 1) {
        const method = req.method ?? 'GET';
        if (method === 'GET') {
          const connection = await deps.storageConnections.get(id);
          if (!connection) {
            return sendJson(res, 404, {
              error: 'not_found',
              message: `unknown storage connection "${id}"`,
            });
          }
          return sendJson(res, 200, { connection });
        }
        if (method === 'PATCH') {
          try {
            const body = await readJson(req);
            const connection = await deps.storageConnections.update(id, body);
            return sendJson(res, 200, { connection });
          } catch (err) {
            return sendConnectionError(res, err);
          }
        }
        if (method === 'DELETE') {
          try {
            await deps.storageConnections.delete(id);
            return sendJson(res, 200, { ok: true });
          } catch (err) {
            return sendConnectionError(res, err);
          }
        }
        return sendJson(res, 405, {
          error: 'method_not_allowed',
          message: 'GET, PATCH, DELETE only',
        });
      }

      if (segments.length === 2 && segments[1] === 'test') {
        if ((req.method ?? 'GET') !== 'POST') {
          return sendJson(res, 405, { error: 'method_not_allowed', message: 'POST only' });
        }
        try {
          const result = await probeConnection(deps.storageConnections, id);
          return sendJson(res, 200, result);
        } catch (err) {
          return sendError(res, err);
        }
      }
    }

    return false;
  };
}
