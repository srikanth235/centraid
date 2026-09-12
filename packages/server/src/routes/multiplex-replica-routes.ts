import type { IncomingMessage } from "node:http";

import { MAX_REPLICA_FEED_MOUNTS } from "@centraid/core/protocol";
import { AUTHED_DEVICE_HEADER, SseStream } from "@centraid/server/engine";
import {
  currentReplicaLogState,
  parseReplicaCursor,
  ReplicaRebootstrapRequiredError,
} from "@centraid/vault";
import type { ReplicaCursor } from "@centraid/vault";

import { unrefTimer } from "../lib/unref-timer.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import { replicaProjectionHub } from "./replica-fanout.js";
import { replicaShapeIds, sameReplicaShapeIds } from "./replica-projection.js";
import type { ReplicaProjectedPage } from "./replica-projection.js";
import { sendJson } from "./route-helpers.js";
import { SseSubscriberCap } from "./sse-cap.js";

export const MULTIPLEX_REPLICA_CHANGES_PATH =
  "/centraid/_gateway/replica/changes";

/**
 * PER-MOUNT FAILURE VOCABULARY (#883 D1). One mount's trouble is a scoped fact,
 * never the whole radio's, so every failure settles into one terminal,
 * per-mount frame the phone can render.
 */
export type MultiplexScopeKind =
  | "rebootstrap"
  | "change"
  | "cursor"
  | "revoked"
  | "error";

/**
 * The phone acts on the FIRST frame; the rest cover one arriving mid-bootstrap.
 * Past that the mount is not listening and re-projecting it every pass is a
 * busy loop against a vault nobody is reading.
 */
export const MAX_MOUNT_REBOOTSTRAP_NOTICES = 3;

interface MountRequest {
  vaultId: string;
  cursor: ReplicaCursor;
  shapeIds?: string[];
}

interface MountedState extends MountRequest {
  baseline?: string[];
  terminal?: boolean;
  /** Bounds the shape-changed re-emit. */
  rebootstrapNotices: number;
}

export interface MultiplexReplicaRouteOptions {
  heartbeatMs?: number;
  limit?: number;
  /** Concurrent multiplex radios this gateway will hold open (#883 C2). */
  subscriberCap?: SseSubscriberCap;
}

/** One cap per process — the #351 Tier 4 bound the other streams carry. */
const defaultMultiplexSubscriberCap = new SseSubscriberCap();

/**
 * One radio, one SSE stream, N sovereign vault logs. No aggregate cursor:
 * each vault has its own epoch and retention floor.
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
    // PER MOUNT, NOT PER RADIO (#1014, V18). A vault may have changed hands
    // while the phone was offline: keep the formerly-known mount long enough to
    // deliver its scoped tombstone, or the local projection is stranded
    // forever. But one unknown vault used to take the WHOLE radio down with a
    // blanket 403 — a phone mounting A,B,C,D where D changed hands went dark on
    // A–C as well — and it did so BEFORE the per-mount check, so the refused
    // device had already subscribed to every hub. A mount this device is not
    // enrolled for is now refused by name, in band, and the rest stream.
    //
    // A tombstoned or unknown DEVICE still fails closed, and so does a radio on
    // which no mount at all is admissible: that is the single-mount client's
    // 403, unchanged.
    if (!enrollments.ownerFor(deviceId))
      return sendJson(res, 403, { error: "replica_scope_not_enrolled" });
    const admitted = mounts.filter(
      (mount) =>
        vaults.get(mount.vaultId) !== undefined &&
        (enrollments.get(deviceId, mount.vaultId) ||
          enrollments.hadReplicaScope(deviceId, mount.vaultId))
    );
    if (admitted.length === 0)
      return sendJson(res, 403, { error: "replica_scope_not_enrolled" });
    const refused = mounts.filter((mount) => !admitted.includes(mount));

    // Bounded BEFORE any header: a saturated gateway answers 503 +
    // Retry-After and the phone resumes from its per-vault cursors.
    const releaseSlot = (
      options.subscriberCap ?? defaultMultiplexSubscriberCap
    ).admit(res, deviceId);
    if (!releaseSlot) return true;

    res.statusCode = 200;
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();
    const stream = new SseStream(res);

    for (const mount of refused)
      writeScope(stream, mount.vaultId, "error", {
        reason: "scope-not-enrolled",
      });
    const states = admitted.map<MountedState>((mount) => ({
      ...mount,
      rebootstrapNotices: 0,
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
    // One hub per mounted vault (#883 C2): this radio shares each vault's
    // registration and per-commit projection with every other stream at the
    // same cursor.
    const hubs = new Map(
      states.map((state) => [
        state.vaultId,
        replicaProjectionHub(vaults.get(state.vaultId)!.db.vault),
      ])
    );
    const unsubscribes = [...hubs.values()].map((hub) =>
      hub.subscribe(() => {
        signaled = true;
        wake?.();
      })
    );
    const heartbeatMs = options.heartbeatMs ?? 15_000;
    let heartbeatAt = Date.now();

    try {
      /*
       * A LOOP, not recursion (#659), one page per mount per pass. `hasMore`
       * re-enters immediately so a large backlog drains at projection speed,
       * and round-robin rather than draining one mount first so a quiet vault
       * is never starved behind a busy one. Mount state stays sovereign: each
       * pass re-reads that mount's enrollment and projects from its own cursor.
       */
      for (;;) {
        // Re-read every pass, including after a multi-page `continue`: that
        // path never yields, so `stream.closed` is the only in-band evidence
        // of a drop mid-drain.
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
          // Doorbell only: this plane wakes the phone, which pulls rows over
          // that vault's own lane. The projection still predicate-tests each
          // changed row (doorbell visibility and the wire row id need it) but
          // stops short of copying values this route would drop.
          let page: ReplicaProjectedPage;
          try {
            page = (
              hubs.get(state.vaultId) ?? replicaProjectionHub(plane.db.vault)
            ).project(
              {
                canWrite: !enrollment.revoked,
                rememberDevice: enrollment.rememberDevice,
              },
              state.cursor,
              options.limit ?? 1_000,
              { doorbellOnly: true }
            );
          } catch (error) {
            // A scoped fact: rebootstrapping one mount must not take the other
            // sovereign mounts down, so only this mount stops projecting and
            // resumes on the phone's post-bootstrap reconnect.
            if (error instanceof ReplicaRebootstrapRequiredError) {
              writeScope(stream, state.vaultId, "rebootstrap", {
                reason: error.reason,
                state: error.state,
              });
              state.terminal = true;
              continue;
            }
            // Never rethrow (#883 D1): that ends the radio and every other
            // sovereign mount on it. One mount's failure is one mount's fact.
            //
            // AND THE PHONE IS TOLD WHAT TO DO WITH IT (#1014, V21). The frame
            // used to carry the exception's own `message` — neither branchable
            // nor readable by a member — and the client had no branch for
            // `error` at all, so the mount went quiet for the life of the radio
            // with no in-band trigger. The reason is a closed code the feed
            // turns into a per-vault re-bootstrap.
            writeScope(stream, state.vaultId, "error", {
              reason: "projection-failed",
            });
            state.terminal = true;
            continue;
          }
          if (
            page.rebootstrapReason ||
            (state.baseline &&
              !sameReplicaShapeIds(page.shapes, state.baseline))
          ) {
            state.rebootstrapNotices += 1;
            writeScope(stream, state.vaultId, "rebootstrap", {
              reason: page.rebootstrapReason ?? "shape-changed",
              state: currentReplicaLogState(plane.db.vault),
            });
            // The cursor cannot advance while the shape set disagrees, so
            // without this bound the mount re-emits the same frame every pass
            // (#883 D1).
            if (state.rebootstrapNotices >= MAX_MOUNT_REBOOTSTRAP_NOTICES) {
              writeScope(stream, state.vaultId, "error", {
                reason: "rebootstrap-unacknowledged",
                notices: state.rebootstrapNotices,
              });
              state.terminal = true;
            }
            continue;
          }
          state.rebootstrapNotices = 0;
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
            // THE SCOPE RECORD, WRITTEN (#1014, V2/X9). Best-effort bookkeeping
            // about a page already on the wire: it is what `hadReplicaScope`
            // reads, so until it had a writer the gate above could only ever
            // see `false`.
            enrollments.noteCheckpoint(deviceId, state.vaultId, {
              epoch: page.batch.to.epoch,
              seq: page.batch.to.seq,
              schemaEpoch: currentReplicaLogState(plane.db.vault).schemaEpoch,
            });
          }
          // `hasMore` only accompanies a page that advanced the cursor, so
          // the drain below always progresses.
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
          unrefTimer(timer);
          wake = () => {
            clearTimeout(timer);
            wake = undefined;
            settle();
          };
        });
      }
    } finally {
      for (const unsubscribe of unsubscribes) unsubscribe();
      releaseSlot();
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
    parsed.length > MAX_REPLICA_FEED_MOUNTS
  ) {
    throw new Error(`mounts must contain 1..${MAX_REPLICA_FEED_MOUNTS} vaults`);
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

// One frame, one vault: `vaultId` rides inside the payload so a scope frame
// can never carry another mount's cursor or rows. Bounded writer (#659) — a
// phone that stops draining is dropped and resumes from its own cursor.
function writeScope(
  stream: SseStream,
  vaultId: string,
  event: MultiplexScopeKind,
  data: unknown
): void {
  stream.event("scope", JSON.stringify({ vaultId, event, data }));
}

function sameCursor(left: ReplicaCursor, right: ReplicaCursor): boolean {
  return left.epoch === right.epoch && left.seq === right.seq;
}
