import type { IncomingMessage, ServerResponse } from "node:http";

import { requestCasGrant } from "@centraid/backup";
import {
  S3BlobStore,
  custodyRollup,
  custodyStateByteCounts,
  custodyStateCounts,
  readBackupPolicy,
  readBlobStoreSettings,
} from "@centraid/vault";

import type { RecoveryKitStateStore } from "../backup/recovery-kit-state.js";
import { StorageConnectionError } from "../backup/storage-connections.js";
import type {
  CreateStorageConnectionInput,
  StorageConnectionStore,
} from "../backup/storage-connections.js";
import {
  assertProviderHomeProfile,
  ensureProviderCasTarget,
  fetchProviderProfileStatus,
} from "../backup/storage-credentials.js";
import type { StorageUsagePoller } from "../backup/storage-usage.js";
import { unrefTimer } from "../lib/unref-timer.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { readJson, sendError, sendJson } from "./route-helpers.js";
import { tryStorageLocalRoutes } from "./storage-local-routes.js";
import type { StorageLocalRouteDeps } from "./storage-local-routes.js";

const CONNECTIONS_PATH = "/centraid/_gateway/storage/connections";
const STATUS_PATH = "/centraid/_gateway/storage/status";
const STATUS_EVENTS_PATH = "/centraid/_gateway/storage/status/events";
const USAGE_PATH = "/centraid/_gateway/storage/usage";

export interface StorageRouteDeps extends StorageLocalRouteDeps {
  storageConnections: StorageConnectionStore;
  recoveryKit: RecoveryKitStateStore;
  vaults: VaultRegistry;
  storageUsage: StorageUsagePoller;
  onConnectionsChanged?: () => Promise<void> | void;
}

function localReplicatedBytesByConnection(
  vaults: VaultRegistry
): Map<string, number> {
  const totals = new Map<string, number>();
  for (const plane of vaults.planesList()) {
    const settings = readBlobStoreSettings(plane.db.vault);
    if (settings.kind !== "s3" || !settings.connectionId) continue;
    const bytes = custodyStateByteCounts(plane.db.vault);
    const replicated = bytes.replicated + bytes["remote-only"];
    totals.set(
      settings.connectionId,
      (totals.get(settings.connectionId) ?? 0) + replicated
    );
  }
  return totals;
}

function looksLikeCreateInput(body: Record<string, unknown>): boolean {
  return body.kind === "provider" && typeof body.name === "string";
}

function sendConnectionError(res: ServerResponse, err: unknown): true {
  if (err instanceof StorageConnectionError) {
    const status =
      err.code === "not_found"
        ? 404
        : err.code === "already_exists"
          ? 409
          : 400;
    return sendJson(res, status, { error: err.code, message: err.message });
  }
  return sendError(res, err);
}

async function probeConnection(
  store: StorageConnectionStore,
  id: string
): Promise<{ ok: true; detail: string } | { ok: false; error: string }> {
  const connection = await store.get(id);
  if (!connection)
    return { ok: false, error: `unknown storage connection "${id}"` };
  if (!connection.baseUrl)
    return { ok: false, error: "connection is missing baseUrl" };
  const probeKey = "0".repeat(64);
  try {
    const apiKey = await store.resolveProviderApiKey(id);
    const profile = await fetchProviderProfileStatus(
      connection.baseUrl,
      apiKey
    );
    if (!profile.isHome) {
      const missing =
        profile.missingCapabilities.length > 0
          ? ` (missing ${profile.missingCapabilities.join(", ")})`
          : "";
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
      mode: "read-write",
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
        "signed request reached the bucket and was accepted; provider advertises the home profile",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

type StoragePlane = ReturnType<VaultRegistry["planesList"]>[number];

function storageStatus(plane: StoragePlane) {
  const settings = readBlobStoreSettings(plane.db.vault);
  const policy = readBackupPolicy(plane.db.vault);
  const counts = custodyStateCounts(plane.db.vault);
  const bytes = custodyStateByteCounts(plane.db.vault);
  const sweep = plane.db.blobs.sweepStatus();
  const metrics = plane.db.blobs.metrics();
  const outbox = plane.db.blobTransfers.status();
  const rollup = custodyRollup(plane.db.vault);
  return {
    vaultId: plane.boot.vaultId,
    name: plane.name,
    configured: settings.kind === "s3",
    ...(settings.connectionId ? { connectionId: settings.connectionId } : {}),
    replicated: {
      count: counts.replicated + counts["remote-only"],
      bytes: bytes.replicated + bytes["remote-only"],
    },
    backlog: { count: outbox.pendingCount, bytes: outbox.pendingBytes },
    pendingOffsite: {
      count: outbox.pendingCount,
      bytes: outbox.pendingBytes,
      uploading: outbox.uploadingCount,
      lastError: outbox.lastError,
    },
    localOnly: { count: counts["local-only"], bytes: bytes["local-only"] },
    custody: { computedAt: rollup.computedAt, buckets: rollup.buckets },
    casAck: policy.casAck,
    outboxBudgetBytes: policy.outboxBudgetBytes,
    reservedHeadroomBytes: policy.reservedHeadroomBytes,
    lastSweep: {
      completedAt: sweep.lastCompletedAt,
      lastAttemptedAt: sweep.lastAttemptedAt,
      error: sweep.lastError,
      consecutiveFailures: sweep.consecutiveFailures,
    },
    ...(policy.throttleBytesPerSec
      ? { throttleBytesPerSec: policy.throttleBytesPerSec }
      : {}),
    cache: {
      spoolBytes: metrics.spoolBytes,
      budgetBytes:
        metrics.budgetBytes === Number.MAX_SAFE_INTEGER
          ? null
          : metrics.budgetBytes,
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
  planes: StoragePlane[]
): true {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const write = (): void => {
    if (!res.writableEnded) {
      res.write(
        `event: custody\ndata: ${JSON.stringify({ vaults: planes.map(storageStatus) })}\n\n`
      );
    }
  };
  write();
  const unsubscribers = planes.map((plane) =>
    plane.db.blobTransfers.subscribe(write)
  );
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(": ping\n\n");
  }, 30_000);
  unrefTimer(heartbeat);
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const unsubscribe of unsubscribers) unsubscribe();
    if (!res.writableEnded) res.end();
  };
  req.on("close", cleanup);
  res.on("error", cleanup);
  return true;
}

export function makeStorageRouteHandler(deps: StorageRouteDeps): RouteHandler {
  return async (
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");

    if (url.pathname === STATUS_PATH || url.pathname === STATUS_EVENTS_PATH) {
      if ((req.method ?? "GET") !== "GET") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "GET only",
        });
      }
      try {
        const planes = deps.vaults.planesList();
        if (url.pathname === STATUS_EVENTS_PATH)
          return streamStorageStatus(req, res, planes);
        const vaults = planes.map(storageStatus);
        return sendJson(res, 200, { vaults });
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (url.pathname === USAGE_PATH) {
      if ((req.method ?? "GET") !== "GET") {
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "GET only",
        });
      }
      try {
        const connections = await deps.storageConnections.list();
        const localBytes = localReplicatedBytesByConnection(deps.vaults);
        const results = await Promise.all(
          connections.map(async (connection) => {
            const usage =
              connection.kind === "provider"
                ? await deps.storageUsage.usageFor(connection.id)
                : { providerReported: null, fetchedAt: null };
            return {
              connectionId: connection.id,
              kind: connection.kind,
              providerReported: usage.providerReported,
              localReplicatedBytes: localBytes.get(connection.id) ?? 0,
              ...(usage.fetchedAt ? { fetchedAt: usage.fetchedAt } : {}),
              ...("error" in usage && usage.error
                ? { error: usage.error }
                : {}),
            };
          })
        );
        return sendJson(res, 200, { connections: results });
      } catch (error) {
        return sendError(res, error);
      }
    }

    if (await tryStorageLocalRoutes(url, req, res, deps)) return true;

    if (url.pathname === CONNECTIONS_PATH) {
      if ((req.method ?? "GET") === "GET") {
        try {
          return sendJson(res, 200, {
            connections: await deps.storageConnections.list(),
          });
        } catch (error) {
          return sendError(res, error);
        }
      }
      if ((req.method ?? "GET") === "POST") {
        try {
          const raw = await readJson(req);
          if (!looksLikeCreateInput(raw)) {
            return sendJson(res, 400, {
              error: "bad_request",
              message:
                'body must carry {kind: "provider", name, baseUrl, apiKey}',
            });
          }
          const body = raw as unknown as CreateStorageConnectionInput;
          const status = await deps.recoveryKit.status();
          const recoveryKitConfirmed = status.confirmedAt !== null;
          if (!recoveryKitConfirmed) {
            return sendJson(res, 409, {
              error: "recovery_kit_not_confirmed",
              recoveryKitConfirmed: false,
              message:
                "export, re-select, and verify the recovery kit before enabling a remote storage tier",
            });
          }
          await assertProviderHomeProfile(body.baseUrl, body.apiKey);
          const connection = await deps.storageConnections.create(body);
          await deps.onConnectionsChanged?.();
          return sendJson(res, 201, { connection, recoveryKitConfirmed });
        } catch (error) {
          return sendConnectionError(res, error);
        }
      }
      return sendJson(res, 405, {
        error: "method_not_allowed",
        message: "GET, POST only",
      });
    }

    if (url.pathname.startsWith(`${CONNECTIONS_PATH}/`)) {
      const rest = url.pathname.slice(CONNECTIONS_PATH.length + 1);
      const segments = rest.split("/").filter(Boolean).map(decodeURIComponent);
      const id = segments[0];
      if (!id) return false;

      if (segments.length === 1) {
        const method = req.method ?? "GET";
        if (method === "GET") {
          const connection = await deps.storageConnections.get(id);
          if (!connection) {
            return sendJson(res, 404, {
              error: "not_found",
              message: `unknown storage connection "${id}"`,
            });
          }
          return sendJson(res, 200, { connection });
        }
        if (method === "PATCH") {
          try {
            const body = await readJson(req);
            const connection = await deps.storageConnections.update(id, body);
            await deps.onConnectionsChanged?.();
            return sendJson(res, 200, { connection });
          } catch (error) {
            return sendConnectionError(res, error);
          }
        }
        if (method === "DELETE") {
          try {
            await deps.storageConnections.delete(id);
            await deps.onConnectionsChanged?.();
            return sendJson(res, 200, { ok: true });
          } catch (error) {
            return sendConnectionError(res, error);
          }
        }
        return sendJson(res, 405, {
          error: "method_not_allowed",
          message: "GET, PATCH, DELETE only",
        });
      }

      if (segments.length === 2 && segments[1] === "test") {
        if ((req.method ?? "GET") !== "POST") {
          return sendJson(res, 405, {
            error: "method_not_allowed",
            message: "POST only",
          });
        }
        try {
          const result = await probeConnection(deps.storageConnections, id);
          return sendJson(res, 200, result);
        } catch (error) {
          return sendError(res, error);
        }
      }
    }

    return false;
  };
}
