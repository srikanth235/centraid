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
 *                                                              connection is usable for `cas` and the
 *                                                              recovery kit hasn't been confirmed, unless
 *                                                              `force: true`
 *   PATCH  /centraid/_gateway/storage/connections/<id>       — update; body = partial CreateStorageConnectionInput
 *   DELETE /centraid/_gateway/storage/connections/<id>       — delete
 *   POST   /centraid/_gateway/storage/connections/<id>/test  — real signed HEAD probe against the connection's
 *                                                              (or, for `provider`, a freshly granted) bucket
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
 *                                                              not noise. A byo-s3 connection has no usage
 *                                                              endpoint, so `providerReported` is always
 *                                                              `null` for it.
 *
 * Every response mirrors `StorageConnectionRecord` — `id, kind, name, uses,
 * createdAt, updatedAt`, plus `endpoint/region/bucket/prefix` (byo-s3) or
 * `baseUrl/targetId` (provider). NEVER a credential field, sealed or not.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  S3BlobStore,
  custodyStateByteCounts,
  custodyStateCounts,
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
import { ensureProviderCasTarget } from '../backup/storage-credentials.js';
import type { StorageUsagePoller } from '../backup/storage-usage.js';
import type { RecoveryKitStateStore } from '../backup/recovery-kit-state.js';
import { readJson, sendError, sendJson } from './route-helpers.js';

const CONNECTIONS_PATH = '/centraid/_gateway/storage/connections';
const STATUS_PATH = '/centraid/_gateway/storage/status';
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
  return (body.kind === 'byo-s3' || body.kind === 'provider') && typeof body.name === 'string';
}

function sendConnectionError(res: ServerResponse, err: unknown): true {
  if (err instanceof StorageConnectionError) {
    const status = err.code === 'not_found' ? 404 : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  return sendError(res, err);
}

/** Real connectivity probe: one signed HEAD against a synthetic key — a 404 IS success (proves auth + reachability, not object existence). */
async function probeConnection(
  store: StorageConnectionStore,
  id: string,
): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const connection = await store.get(id);
  if (!connection) return { ok: false, error: `unknown storage connection "${id}"` };
  const probeKey = '0'.repeat(64);
  try {
    let s3: S3BlobStore;
    if (connection.kind === 'byo-s3') {
      if (!connection.endpoint || !connection.region || !connection.bucket) {
        return { ok: false, error: 'connection is missing endpoint/region/bucket' };
      }
      const creds = await store.resolveS3Credentials(id);
      s3 = new S3BlobStore({
        endpoint: connection.endpoint,
        region: connection.region,
        bucket: connection.bucket,
        ...(connection.prefix ? { prefix: connection.prefix } : {}),
        credentials: async () => creds,
      });
    } else {
      const target = await ensureProviderCasTarget(store, id);
      const refreshed = await store.get(id);
      const apiKey = await store.resolveProviderApiKey(id);
      const grant = await requestCasGrant({
        baseUrl: connection.baseUrl!,
        apiKey,
        targetId: refreshed!.targetId!,
        mode: 'read-write',
      });
      s3 = new S3BlobStore({
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
    }
    await s3.stat(probeKey);
    return { ok: true, detail: 'signed request reached the bucket and was accepted' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function makeStorageRouteHandler(deps: StorageRouteDeps): RouteHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://gateway.local');

    if (url.pathname === STATUS_PATH) {
      if ((req.method ?? 'GET') !== 'GET') {
        return sendJson(res, 405, { error: 'method_not_allowed', message: 'GET only' });
      }
      try {
        const vaults = deps.vaults.planesList().map((plane) => {
          const settings = readBlobStoreSettings(plane.db.vault);
          const counts = custodyStateCounts(plane.db.vault);
          const bytes = custodyStateByteCounts(plane.db.vault);
          const sweep = plane.db.blobs.sweepStatus();
          // Bounded storage-tier health (issue #405 §7 — "tier health is
          // invisible today"). custody exposes state counts/bytes only; the
          // cache counters are the missing read. `budgetBytes` surfaces as
          // `null` for an unlimited tier (the cache's UNLIMITED sentinel is
          // Number.MAX_SAFE_INTEGER — a vault with no disk to measure, e.g. a
          // MemoryBlobStore), so the UI shows an "unlimited" state instead of
          // a nonsensically-huge budget bar.
          const metrics = plane.db.blobs.metrics();
          return {
            vaultId: plane.boot.vaultId,
            name: plane.name,
            configured: settings.kind === 's3',
            ...(settings.connectionId ? { connectionId: settings.connectionId } : {}),
            replicated: { count: counts.replicated, bytes: bytes.replicated },
            backlog: {
              count: counts['local-only'] + counts['remote-only'],
              bytes: bytes['local-only'] + bytes['remote-only'],
            },
            lastSweep: {
              completedAt: sweep.lastCompletedAt,
              lastAttemptedAt: sweep.lastAttemptedAt,
              error: sweep.lastError,
              consecutiveFailures: sweep.consecutiveFailures,
            },
            ...(settings.throttleBytesPerSec
              ? { throttleBytesPerSec: settings.throttleBytesPerSec }
              : {}),
            cache: {
              spoolBytes: metrics.spoolBytes,
              budgetBytes:
                metrics.budgetBytes === Number.MAX_SAFE_INTEGER ? null : metrics.budgetBytes,
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
        });
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
              message: 'body must carry {kind: "byo-s3"|"provider", name, ...}',
            });
          }
          const body = raw as unknown as CreateStorageConnectionInput;
          const uses = body.uses ?? ['backup', 'cas'];
          const usableForCas = uses.includes('cas');
          const status = await deps.recoveryKit.status();
          const recoveryKitConfirmed = status.confirmedAt !== null;
          if (usableForCas && !recoveryKitConfirmed && !force) {
            return sendJson(res, 409, {
              error: 'recovery_kit_not_confirmed',
              recoveryKitConfirmed: false,
              message:
                'confirm you have exported and safely stored the recovery kit before enabling a ' +
                'remote storage tier (or resend with {force: true} to bypass)',
            });
          }
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
