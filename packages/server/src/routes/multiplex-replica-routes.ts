import type { IncomingMessage } from "node:http";

import { MAX_MULTIPLEX_REPLICA_SCOPES } from "@centraid/core/protocol";
import { AUTHED_DEVICE_HEADER, SseStream } from "@centraid/server/engine";
import {
  currentReplicaLogState,
  parseReplicaCursor,
  ReplicaRebootstrapRequiredError,
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
import type { ReplicaProjectedPage } from "./replica-projection.js";
import { sendJson } from "./route-helpers.js";

export const MULTIPLEX_REPLICA_CHANGES_PATH =
  "/centraid/_gateway/replica/changes";

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
    const stream = new SseStream(res);

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
      /*
       * A LOOP, not recursion (#659), and one page per mount per pass. A mount
       * whose page reports `hasMore` re-enters immediately instead of falling
       * into the wait below, so a 50k-change backlog drains at projection speed
       * rather than one page per heartbeat. Round-robin rather than draining
       * one mount to completion first: a phone with a busy vault and a quiet
       * one must not have the quiet one starved behind the busy one's backlog.
       * Mount state stays sovereign throughout — each pass re-reads that
       * mount's enrollment, projects from that mount's own cursor, and emits
       * frames tagged with its own `vaultId`.
       */
      for (;;) {
        // Socket gone: the client hung up, or SseStream dropped it for
        // backpressure and destroyed the response. Re-read every pass,
        // including after a `continue` from a multi-page drain — that path
        // never yields to the event loop, so `stream.closed` is the only
        // in-band evidence a drop happened mid-drain.
        if (closed || stream.closed) break;
        signaled = false;
        let drained = true;
        for (const state of states) {
          if (state.terminal) continue;
          const enrollment = enrollments.get(deviceId, state.vaultId);
          const plane = vaults.get(state.vaultId);
          if (!plane || !enrollment || enrollment.revoked) {
            writeScope(stream, state.vaultId, "revoked", {
              reason: "device-access-changed",
            });
            state.terminal = true;
            continue;
          }
          // Doorbell only: this plane wakes the phone, which then pulls the
          // rows over that vault's own replica lane. The projection still
          // reads and predicate-tests each changed row — doorbell visibility
          // and the wire row id need it — but `doorbellOnly` stops it short of
          // copying row values into a `batch.changes` this route would drop.
          let page: ReplicaProjectedPage;
          try {
            page = projectReplicaPage(
              plane.db.vault,
              {
                canWrite: !enrollment.revoked,
                rememberDevice: enrollment.rememberDevice,
              },
              state.cursor,
              options.limit ?? 1_000,
              { doorbellOnly: true }
            );
          } catch (error) {
            // One mount's cursor fell behind its vault's retention floor, or
            // its epoch rolled: a scoped fact. Rebootstrapping that mount
            // must not take the other sovereign mounts' streams down with it,
            // so the frame is scoped and only this mount stops projecting —
            // it resumes on the reconnect the phone makes after bootstrapping.
            if (!(error instanceof ReplicaRebootstrapRequiredError))
              throw error;
            writeScope(stream, state.vaultId, "rebootstrap", {
              reason: error.reason,
              state: error.state,
            });
            state.terminal = true;
            continue;
          }
          if (
            page.rebootstrapReason ||
            (state.baseline &&
              !sameReplicaShapeIds(page.shapes, state.baseline))
          ) {
            writeScope(stream, state.vaultId, "rebootstrap", {
              reason: page.rebootstrapReason ?? "shape-changed",
              state: currentReplicaLogState(plane.db.vault),
            });
            continue;
          }
          state.baseline ??= replicaShapeIds(page.shapes);
          if (page.doorbell.length > 0) {
            writeScope(stream, state.vaultId, "change", {
              changes: page.doorbell,
              cursor: page.batch.to,
            });
          }
          if (!sameCursor(state.cursor, page.batch.to)) {
            writeScope(stream, state.vaultId, "cursor", page.batch.to);
            state.cursor = page.batch.to;
          }
          // `hasMore` only ever accompanies a page that advanced this mount's
          // cursor, so the drain below always makes progress.
          if (page.batch.hasMore) drained = false;
        }
        if (closed || stream.closed) break;
        // More pages waiting on some mount: project the next one right away.
        if (!drained) continue;
        if (Date.now() - heartbeatAt >= heartbeatMs) {
          stream.comment("heartbeat");
          heartbeatAt = Date.now();
        }
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
      stream.end();
    }
    return true;
  };
}

function parseMounts(raw: string | null): MountRequest[] {
  const parsed = JSON.parse(raw ?? "null") as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.length > MAX_MULTIPLEX_REPLICA_SCOPES
  ) {
    throw new Error(
      `mounts must contain 1..${MAX_MULTIPLEX_REPLICA_SCOPES} scopes`
    );
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

// One frame, one vault: `vaultId` is inside the payload so a scope frame can
// never carry another mount's cursor or rows. Every frame goes through the
// bounded writer (#659) — a phone that stops draining is dropped and resumes
// from its own durable per-vault cursor on reconnect.
function writeScope(
  stream: SseStream,
  vaultId: string,
  event: string,
  data: unknown
): void {
  stream.event("scope", JSON.stringify({ vaultId, event, data }));
}

function sameCursor(left: ReplicaCursor, right: ReplicaCursor): boolean {
  return left.epoch === right.epoch && left.seq === right.seq;
}
