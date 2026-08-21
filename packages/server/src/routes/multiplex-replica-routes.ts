import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/server/engine";
import {
  currentReplicaLogState,
  parseReplicaCursor,
  subscribeReplicaCommits,
} from "@centraid/vault";
import type { ReplicaCursor } from "@centraid/vault";

import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import {
  projectReplicaPage,
  replicaShapeIds,
  sameReplicaShapeIds,
} from "./replica-projection.js";
import { sendJson } from "./route-helpers.js";

export const MULTIPLEX_REPLICA_CHANGES_PATH =
  "/centraid/_gateway/replica/changes";
const MAX_MULTIPLEX_SCOPES = 4;

interface MountRequest {
  vaultId: string;
  cursor: ReplicaCursor;
  shapeIds?: string[];
}

interface MountedState extends MountRequest {
  baseline?: string[];
  terminal?: boolean;
}

export interface MultiplexReplicaRouteOptions {
  heartbeatMs?: number;
  limit?: number;
}

/**
 * One radio, one SSE stream, N sovereign vault logs. Frames retain their
 * `vaultId`; there is no aggregate cursor because each vault has its own epoch
 * and retention floor.
 */
export function makeMultiplexReplicaRouteHandler(
  vaults: VaultRegistry,
  enrollments: EnrollmentStore,
  options: MultiplexReplicaRouteOptions = {}
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (url.pathname !== MULTIPLEX_REPLICA_CHANGES_PATH) return false;
    if ((req.method ?? "GET") !== "GET")
      return sendJson(res, 405, { error: "method_not_allowed" });

    const deviceId = callerDeviceId(req);
    if (!deviceId)
      return sendJson(res, 403, { error: "device_identity_required" });
    let mounts: MountRequest[];
    try {
      mounts = parseMounts(url.searchParams.get("mounts"));
    } catch (error) {
      return sendJson(res, 400, {
        error: "invalid_replica_mounts",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // A still-valid device may reconnect with a scope whose vault changed
    // hands or vanished while the phone was offline. Keep that
    // formerly-known mount in
    // the stream long enough to deliver its scoped tombstone; rejecting the
    // whole request would strand the local projection forever. A tombstoned
    // device, unknown device, or unknown vault still fails closed.
    if (
      !enrollments.ownerFor(deviceId) ||
      mounts.some(
        (mount) =>
          vaults.get(mount.vaultId) === undefined ||
          (!enrollments.get(deviceId, mount.vaultId) &&
            !enrollments.hadReplicaScope(deviceId, mount.vaultId))
      )
    )
      return sendJson(res, 403, { error: "replica_scope_not_enrolled" });

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const states = mounts.map<MountedState>((mount) => ({
      ...mount,
      ...(mount.shapeIds ? { baseline: mount.shapeIds } : {}),
    }));
    let closed = false;
    let signaled = true;
    let wake: (() => void) | undefined;
    const close = (): void => {
      closed = true;
      wake?.();
    };
    req.on("close", close);
    res.on("close", close);
    const unsubscribes = states.map((state) =>
      subscribeReplicaCommits(vaults.get(state.vaultId)!.db.vault, () => {
        signaled = true;
        wake?.();
      })
    );
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    let heartbeatAt = Date.now();

    try {
      while (true) {
        if (closed) break;
        signaled = false;
        for (const state of states) {
          if (state.terminal) continue;
          const enrollment = enrollments.get(deviceId, state.vaultId);
          const plane = vaults.get(state.vaultId);
          if (!plane || !enrollment || enrollment.revoked) {
            writeScope(res, state.vaultId, "revoked", {
              reason: "device-access-changed",
            });
            state.terminal = true;
            continue;
          }
          const page = projectReplicaPage(
            plane.db.vault,
            {
              canWrite: !enrollment.revoked,
              rememberDevice: enrollment.rememberDevice,
            },
            state.cursor,
            options.limit ?? 1_000
          );
          if (
            page.rebootstrapReason ||
            (state.baseline &&
              !sameReplicaShapeIds(page.shapes, state.baseline))
          ) {
            writeScope(res, state.vaultId, "rebootstrap", {
              reason: page.rebootstrapReason ?? "shape-changed",
              state: currentReplicaLogState(plane.db.vault),
            });
            continue;
          }
          state.baseline ??= replicaShapeIds(page.shapes);
          if (page.doorbell.length > 0) {
            writeScope(res, state.vaultId, "change", {
              changes: page.doorbell,
              cursor: page.batch.to,
            });
          }
          if (!sameCursor(state.cursor, page.batch.to)) {
            writeScope(res, state.vaultId, "cursor", page.batch.to);
            state.cursor = page.batch.to;
          }
        }
        if (Date.now() - heartbeatAt >= heartbeatMs) {
          res.write(": heartbeat\n\n");
          heartbeatAt = Date.now();
        }
        if (closed) break;
        // oxlint-disable-next-line no-await-in-loop -- each SSE heartbeat waits for the next commit signal
        await new Promise<void>((resolve) => {
          let settled = false;
          const settle = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          if (signaled) settle();
          if (signaled) return;
          const timer = setTimeout(settle, heartbeatMs);
          timer.unref?.();
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            settle();
          };
        });
      }
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      req.off("close", close);
      res.off("close", close);
      if (!res.writableEnded) res.end();
    }
    return true;
  };
}

function parseMounts(raw: string | null): MountRequest[] {
  const parsed = JSON.parse(raw ?? "null") as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_MULTIPLEX_SCOPES
  ) {
    throw new Error(`mounts must contain 1..${MAX_MULTIPLEX_SCOPES} scopes`);
  }
  const seen = new Set<string>();
  return parsed.map((value) => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new Error("each mount must be an object");
    const row = value as Record<string, unknown>;
    if (
      typeof row.vaultId !== "string" ||
      row.vaultId.length === 0 ||
      seen.has(row.vaultId)
    )
      throw new Error("vaultId must be a unique non-empty string");
    seen.add(row.vaultId);
    const cursor = parseReplicaCursor(row.cursor as ReplicaCursor);
    const shapeIds =
      row.shapeIds === undefined
        ? undefined
        : Array.isArray(row.shapeIds) &&
            row.shapeIds.every((entry) => typeof entry === "string")
          ? [...new Set(row.shapeIds as string[])].sort()
          : undefined;
    if (row.shapeIds !== undefined && shapeIds === undefined)
      throw new Error("shapeIds must be an array of strings");
    return { vaultId: row.vaultId, cursor, ...(shapeIds ? { shapeIds } : {}) };
  });
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function writeScope(
  res: ServerResponse,
  vaultId: string,
  event: string,
  data: unknown
): void {
  res.write(
    `event: scope\ndata: ${JSON.stringify({ vaultId, event, data })}\n\n`
  );
}

function sameCursor(left: ReplicaCursor, right: ReplicaCursor): boolean {
  return left.epoch === right.epoch && left.seq === right.seq;
}
