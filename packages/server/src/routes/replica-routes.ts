// governance: allow-repo-hygiene file-size-limit (#406) one protocol route keeps bootstrap, pull/SSE, lazy-row, checkpoint, and intent admission semantics together
/* Replica HTTP protocol: authenticated bootstrap, pull/stream, lazy row and intent lanes. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type * as TypeImport_18fk7n9 from "node:sqlite";

import { SseStream } from "@centraid/server/engine";
import {
  currentReplicaLogState,
  InvalidReplicaCursorError,
  parseReplicaCursor,
  ReplicaRebootstrapRequiredError,
  REPLICA_RETENTION_DAYS,
  REPLICA_RETENTION_MAX_ENTRIES,
} from "@centraid/vault";
import type { ReplicaCursor, ReplicaLogState } from "@centraid/vault";

import { unrefTimer } from "../lib/unref-timer.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { ProjectedEditForwarder } from "../serve/projected-edit.js";
import { vaultContext } from "../serve/vault-context.js";
import type { VaultRegistry } from "../serve/vault-registry.js";
import {
  expectedReplicaShapeIds,
  resolveReplicaAccess,
} from "./replica-access.js";
import type { ReplicaRequestAccess } from "./replica-access.js";
import { replicaProjectionHub } from "./replica-fanout.js";
import { handleReplicaIntent } from "./replica-intent-route.js";
import type { ReplicaIntentDispatcher } from "./replica-intent-route.js";
import { replicaShapeIds, sameReplicaShapeIds } from "./replica-projection.js";
import { sendJson } from "./route-helpers.js";
import { SseSubscriberCap } from "./sse-cap.js";

const CHANGES_PATH = "/centraid/_vault/changes";
export const REPLICA_INTENTS_PATH = "/centraid/_vault/replica/intents";
// Windowed bootstrap (#419), an ADDITIVE paging protocol: `?window=<1..20000>`
// and/or `?after=<token>` opt in, and absent both the single-shot body below is
// byte-for-byte unchanged. Page 1 carries the shapes; continuations do not.
//
// Each page opens its OWN read snapshot, so pages are NOT globally consistent
// and every page reports its own cursor. CONVERGENCE IS REQUIRED OF THE CLIENT:
// after `complete`, pull `GET /changes?since=<page-1 cursor>` — page 1 holds the
// minimum cursor, so replaying from it is idempotent and repairs whatever moved
// between snapshots. Skip it and deletions between pages leak.
//
// 409 mid-pagination on an epoch, schemaEpoch or shape-set change, or a log
// floor past the pinned page-1 cursor; 400 on a tampered token.

export interface ReplicaRouteOptions {
  enrollments?: EnrollmentStore;
  dispatchIntent: ReplicaIntentDispatcher;
  /** How an edit of a projected row reaches its origin (#996, R10). Absent on
   *  a host with no peer plane; the route then answers in-flight rather than
   *  writing another vault's row locally. */
  forwardProjectedEdit?: ProjectedEditForwarder;
  heartbeatMs?: number;
  /** Concurrent change streams this gateway will hold open (#883 C2). */
  subscriberCap?: SseSubscriberCap;
}

/**
 * One cap per gateway process. A shared projection still costs a socket, a
 * bounded writer and a wake per subscriber, so this stream carries the same
 * #351 Tier 4 bound as logs, automations and notifications.
 */
const defaultReplicaSubscriberCap = new SseSubscriberCap();

/**
 * The CLOSED set of verdicts a client is told to start over with (#883 C6).
 * Closed is the point: `packages/client`'s `replica/rebootstrap-copy.ts` maps
 * every one to a sentence a member can act on, so a verdict added here without
 * copy there is a type error rather than a generic error screen.
 *
 * `retention` (cursor below the log's collected floor — the deltas are GONE) is
 * distinct from `snapshot-retention` (a bootstrap walk outliving its own pinned
 * page-1 cursor): different member stories, different copy. The first three are
 * the vault's own `ReplicaRebootstrapReason` values, carried through verbatim.
 */
export const REPLICA_REBOOTSTRAP_VERDICTS = [
  "epoch-mismatch",
  "retention",
  "cursor-ahead",
  "initial",
  "epoch-changed",
  "snapshot-retention",
  "shape-changed",
  "checkpoint-incompatible",
  "invalid-cursor",
] as const;

export type ReplicaRebootstrapVerdict =
  (typeof REPLICA_REBOOTSTRAP_VERDICTS)[number];

/**
 * Anything unrecognised becomes `invalid-cursor`: no raw `Error.message` may
 * reach the wire, where it is neither branchable nor readable by a member.
 */
function normalizeRebootstrapReason(reason: string): ReplicaRebootstrapVerdict {
  return (REPLICA_REBOOTSTRAP_VERDICTS as readonly string[]).includes(reason)
    ? (reason as ReplicaRebootstrapVerdict)
    : "invalid-cursor";
}

function rebootstrapBody(
  reason: string,
  state: ReplicaLogState
): Record<string, unknown> {
  return {
    error: "replica_rebootstrap_required",
    reason: normalizeRebootstrapReason(reason),
    state: {
      epoch: state.epoch,
      schemaEpoch: String(state.schemaEpoch),
      floor: state.floor,
      watermark: state.watermark,
      epochReason: state.epochReason,
    },
    // The facts behind the reason, so the client describes THIS gateway's
    // retention rather than a number it made up.
    retention: {
      days: REPLICA_RETENTION_DAYS,
      maxEntries: REPLICA_RETENTION_MAX_ENTRIES,
    },
  };
}

function methodAllowed(res: ServerResponse, allowed: string): true {
  res.setHeader("Allow", allowed);
  return sendJson(res, 405, { error: "method_not_allowed" });
}

function parseLimit(url: URL): number | undefined {
  const raw = url.searchParams.get("limit");
  if (raw === null) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 1 && value <= 10_000
    ? value
    : NaN;
}

function isSse(req: IncomingMessage, url: URL): boolean {
  return (
    url.searchParams.get("stream") === "1" ||
    String(req.headers.accept ?? "").includes("text/event-stream")
  );
}
// Bounded writer (#659): a device that stops draining is dropped and re-syncs
// from its checkpoint, rather than accumulating in gateway memory.
function writeSse(stream: SseStream, event: string, data: unknown): void {
  stream.event(event, JSON.stringify(data));
}

function sameCursor(left: ReplicaCursor, right: ReplicaCursor): boolean {
  return left.epoch === right.epoch && left.seq === right.seq;
}
function accessFor(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  vaultId: string,
  enrollments?: EnrollmentStore
): ReplicaRequestAccess | undefined {
  const resolution = resolveReplicaAccess(url, vaultId, enrollments);
  if (!resolution.ok) {
    sendJson(res, resolution.status, resolution.body);
    return undefined;
  }
  return resolution.access;
}
function parseSince(url: URL): ReplicaCursor {
  const since = url.searchParams.get("since");
  if (since === null)
    throw new InvalidReplicaCursorError("replica since cursor is required");
  if (since === "0:0")
    throw new InvalidReplicaCursorError("replica bootstrap sentinel");
  return parseReplicaCursor(since);
}

function sendSseRebootstrap(
  stream: SseStream,
  reason: string,
  state: ReplicaLogState
): void {
  writeSse(stream, "rebootstrap", rebootstrapBody(reason, state));
  stream.end();
}

async function streamChanges(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  db: TypeImport_18fk7n9.DatabaseSync,
  vaultId: string,
  options: ReplicaRouteOptions,
  limit: number,
  subscriberCap: SseSubscriberCap
): Promise<true> {
  const rawSince = url.searchParams.get("since");
  // Bounded BEFORE any header is written (#351 Tier 4): a saturated gateway
  // answers 503 + Retry-After, and the device resumes from its own checkpoint.
  const releaseSlot = subscriberCap.admit(res);
  if (!releaseSlot) return true;
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  const stream = new SseStream(res);
  if (rawSince === "0:0") {
    sendSseRebootstrap(stream, "initial", currentReplicaLogState(db));
    releaseSlot();
    return true;
  }
  let cursor: ReplicaCursor;
  try {
    cursor = parseSince(url);
  } catch (error) {
    writeSse(stream, "rebootstrap", {
      error: "replica_rebootstrap_required",
      reason: error instanceof Error ? error.message : "invalid-cursor",
    });
    stream.end();
    releaseSlot();
    return true;
  }
  const expected = expectedReplicaShapeIds(url);
  let baseline = expected;
  let closed = false;
  let signalPending = false;
  let wake: (() => void) | undefined;
  const close = () => {
    closed = true;
    wake?.();
  };
  req.on("close", close);
  res.on("close", close);
  // ONE projection per commit for the whole household (#883 C2): the hub fans
  // the same page to every subscriber sharing this cursor and authorization.
  // That page is SHARED — read it, never mutate it.
  const hub = replicaProjectionHub(db);
  const unsubscribe = hub.subscribe(() => {
    signalPending = true;
    wake?.();
  });
  let heartbeatAt = Date.now();
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  /*
   * A LOOP, not recursion (#659): a `streamNext()` tail-calling itself per page
   * and per wake grows a promise chain with the connection's age.
   *
   * `for (;;)` + explicit `if (closed) break` rather than `while (!closed)`:
   * `closed` is set from socket-close listeners no reader can see from the loop
   * header, so every exit sits in the body — this one, the two rebootstrap
   * breaks, and the access break.
   */
  for (;;) {
    // Re-read every pass, including after a multi-page `continue` and the wake.
    if (closed) break;
    const access = resolveReplicaAccess(url, vaultId, options.enrollments);
    if (!access.ok) {
      sendSseRebootstrap(
        stream,
        "device-access-changed",
        currentReplicaLogState(db)
      );
      break;
    }
    let drained = true;
    try {
      const page = hub.project(access.access, cursor, limit);
      if (
        page.rebootstrapReason ||
        (baseline && !sameReplicaShapeIds(page.shapes, baseline))
      ) {
        sendSseRebootstrap(
          stream,
          page.rebootstrapReason ?? "shape-changed",
          currentReplicaLogState(db)
        );
        break;
      }
      baseline ??= replicaShapeIds(page.shapes);
      if (page.doorbell.length > 0) {
        // SB-payload (#922 A1): the frame carries the batch the hub ALREADY
        // projected, so a subscribed device applies it in one hop instead of
        // discarding the doorbell and pulling `/changes` — which re-projected
        // the same window outside the hub memo. Catch-up still pulls:
        // `hasMore`, a reconnect, or a cursor gap. `changes` stays the
        // doorbell so shape routing does not have to open the batch.
        writeSse(stream, "change", {
          changes: page.doorbell,
          cursor: page.batch.to,
          batch: page.batch,
        });
      }
      if (!sameCursor(cursor, page.batch.to))
        writeSse(stream, "cursor", page.batch.to);
      cursor = page.batch.to;
      drained = !page.batch.hasMore;
    } catch (error) {
      if (error instanceof ReplicaRebootstrapRequiredError) {
        sendSseRebootstrap(stream, error.reason, error.state);
        break;
      }
      writeSse(stream, "retry", {
        error: "replica_stream_retry",
        message: error instanceof Error ? error.message : String(error),
      });
    }
    // More pages waiting: project the next one right away.
    if (!drained) continue;
    if (Date.now() - heartbeatAt >= heartbeatMs) {
      stream.comment("heartbeat");
      heartbeatAt = Date.now();
    }
    // The loop IS the wait: each pass blocks until a commit, wake or heartbeat.
    // oxlint-disable-next-line no-await-in-loop -- sequential by construction
    await new Promise<void>((resolve) => {
      let settled = false;
      const settle = (): void => {
        if (settled) return;
        settled = true;
        resolve();
      };
      if (signalPending || closed) {
        signalPending = false;
        settle();
        return;
      }
      const timer = setTimeout(
        () => {
          wake = undefined;
          settle();
        },
        Math.max(1, heartbeatMs - (Date.now() - heartbeatAt))
      );
      unrefTimer(timer);
      wake = () => {
        clearTimeout(timer);
        wake = undefined;
        signalPending = false;
        settle();
      };
    });
  }
  unsubscribe();
  releaseSlot();
  req.off("close", close);
  res.off("close", close);
  if (!closed && !res.writableEnded) res.end();
  return true;
}

/**
 * WHAT IS LEFT OF THE REPLICA ROUTES AFTER #996 W5.
 *
 * Two doors. The INTENT door, which is how a member's write reaches the
 * gateway and has not changed; and the CHANGE FEED, which is now a WAKE and
 * only a wake — a seat that is told there is something to read goes and reads
 * the gateway's own log door for itself.
 *
 * The bootstrap, row, checkpoint and outcome-reconciliation doors are gone
 * with the plane they served: each of them composed the vault into a device's
 * SHAPES, and a seat holds the vault's own file.
 */
export function makeReplicaRouteHandler(
  vaults: VaultRegistry,
  options: ReplicaRouteOptions
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (![CHANGES_PATH, REPLICA_INTENTS_PATH].includes(url.pathname))
      return false;
    const plane = vaults.current();
    const vaultId = vaultContext()?.vaultId ?? plane.boot.vaultId;
    const access = accessFor(req, res, url, vaultId, options.enrollments);
    if (!access) return true;
    const method = (req.method ?? "GET").toUpperCase();

    if (url.pathname === CHANGES_PATH) {
      if (method !== "GET") return methodAllowed(res, "GET");
      const limit = parseLimit(url);
      if (Number.isNaN(limit))
        return sendJson(res, 400, { error: "invalid_replica_limit" });
      if (isSse(req, url))
        return streamChanges(
          req,
          res,
          url,
          plane.db.vault,
          vaultId,
          options,
          limit ?? 1_000,
          options.subscriberCap ?? defaultReplicaSubscriberCap
        );
      // THE FEED IS A WAKE, AND ONLY A WAKE (#996, W5). The JSON page that
      // used to be served here was the SHAPED projection: a device asked for
      // changes since a cursor and got rows composed against its shapes. A
      // seat reads the gateway's own log door instead, so what is left of this
      // route is the stream that tells a seat there is something to read.
      return sendJson(res, 410, {
        error: "replica_changes_removed",
        message:
          "the shaped changes page is gone; a seat reads /centraid/_vault/seat/log",
      });
    }

    if (method !== "POST") return methodAllowed(res, "POST");
    return handleReplicaIntent(req, res, {
      plane,
      access,
      dispatch: options.dispatchIntent,
      ...(options.forwardProjectedEdit === undefined
        ? {}
        : { forwardProjectedEdit: options.forwardProjectedEdit }),
    });
  };
}
