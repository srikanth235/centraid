/*
 * The device-facing route onto a BORROWED shape (#726 P5 — the P4 device
 * route deferred by "P4 reach" item 6). P4 listed a borrowed scope in
 * `GET /_vault/scopes`, but a phone had nowhere to actually pull its rows
 * from: this file is that door.
 *
 * The borrowed store's schema already matches the device replica's wire
 * shape (`store-core.ts`'s six tables — see `borrowed-store.ts`'s header),
 * so this re-projects `BorrowedStore.rows()`/its change log through a wire
 * envelope shaped like `replica-routes.ts`'s own bootstrap/changes, rather
 * than forcing a borrowed shape through the per-entity-SQL machinery
 * `buildReplicaShapes` was built for — a borrowed shape has no live vault.db
 * behind it on THIS gateway, only the audience's own local copy.
 *
 * AUTHORIZATION is ownership, exactly like `scopes-routes.ts`'s borrowed
 * listing: the caller's OWNER must own the edge's `audience_vault_id` — no
 * enrollment-to-a-specific-vault check exists for a borrowed scope (a
 * device is enrolled to vaults it OWNS, never to ones it borrows from). A
 * vault the caller's owner does not own is `not_found`, identical to an
 * unknown edge id — topology hiding, same as every other lend route.
 */

import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { AUTHED_DEVICE_HEADER } from "@centraid/app-engine";
import { ROUTES } from "@centraid/protocol";

import type {
  BorrowedChangeEntry,
  BorrowedStore,
} from "../serve/borrowed-store.js";
import type { RouteHandler } from "../serve/build-gateway.js";
import type { EnrollmentStore } from "../serve/enrollment-store.js";
import type { GatewayDatabase } from "../serve/gateway-db.js";
import {
  expectedPayloadHash,
  parseBaseVersions,
} from "./replica-intent-shape.js";
import type { ReplicaIntentBaseVersion } from "./replica-intent-shape.js";
import { readJson, sendJson } from "./route-helpers.js";

export const BORROWED_BOOTSTRAP_PATH = ROUTES.vaultReplicaBorrowedBootstrap;
export const BORROWED_CHANGES_PATH = ROUTES.vaultReplicaBorrowedChanges;
export const BORROWED_INTENTS_PATH = ROUTES.vaultReplicaBorrowedIntents;
export const BORROWED_OUTCOMES_PATH = ROUTES.vaultReplicaBorrowedOutcomes;

const PROTOCOL_VERSION = 1;

export interface BorrowedReplicaRouteDeps {
  gatewayDatabase: GatewayDatabase;
  enrollments: EnrollmentStore;
  /** Per COUNTERPARTY VAULT, opened lazily by the caller — same accessor
   *  the lend sync/sweep code already uses. */
  storeFor: (peerVaultId: string) => BorrowedStore;
}

interface BorrowedEdgeAuthRow {
  origin_vault_id: string;
  audience_vault_id: string;
  verbs: "read" | "read+act";
  state: "offered" | "established" | "parked" | "dropped";
}

function replicaVaultId(edgeId: string): string {
  return `borrowed:${edgeId}`;
}

function replicaCursor(
  edgeId: string,
  seq: number
): { epoch: string; seq: number } {
  return { epoch: replicaVaultId(edgeId), seq };
}

function wireOutcome(
  record: ReturnType<BorrowedStore["intent"]>
): Record<string, unknown> | undefined {
  if (!record || record.status === "queued" || record.status === "sending")
    return undefined;
  return {
    intentId: record.intentId,
    status: record.status,
    ...(record.reason ? { reason: record.reason } : {}),
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(record.conflict === undefined ? {} : { conflict: record.conflict }),
  };
}

function callerDeviceId(req: IncomingMessage): string | undefined {
  const raw = req.headers[AUTHED_DEVICE_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function notFound(res: ServerResponse): true {
  return sendJson(res, 404, { error: "not_found" });
}

/**
 * Resolve + authorize an edge for a device request. A dropped edge, an edge
 * naming a vault this owner does not own, and an edge that never existed
 * all leave the SAME trace (`not_found`, topology hiding) — but a caller
 * with no proved device identity at all is a different failure (never
 * silently folded into "unknown edge").
 */
function authorizedEdge(
  deps: BorrowedReplicaRouteDeps,
  owner: { ownerId: string },
  edgeId: string
): { row: BorrowedEdgeAuthRow } | undefined {
  const row = deps.gatewayDatabase.db
    .prepare(
      `SELECT origin_vault_id, audience_vault_id, verbs, state
         FROM borrowed_edges WHERE edge_id = ?`
    )
    .get(edgeId) as BorrowedEdgeAuthRow | undefined;
  if (!row || row.state === "dropped") return undefined;
  if (deps.enrollments.owners.ownerOf(row.audience_vault_id) !== owner.ownerId)
    return undefined;
  return { row };
}

/**
 * A device's first read of a borrowed shape — every row, one page (v0: no
 * cross-entity row windowing, matching this feature area's own documented
 * v0 posture elsewhere — a lent scope is a consent-scoped slice, not a
 * whole vault). `not_yet_available` is a STATE, not an error: the edge is
 * real and this owner's, but the audience gateway has not landed a shape
 * from the origin yet (the sweep has not ticked, or the origin is offline).
 */
function handleBootstrap(
  res: ServerResponse,
  deps: BorrowedReplicaRouteDeps,
  row: Pick<BorrowedEdgeAuthRow, "origin_vault_id">,
  edgeId: string
): true {
  const store = deps.storeFor(row.origin_vault_id);
  const shape = store.shapeForEdge(edgeId);
  if (!shape) {
    return sendJson(res, 503, {
      error: "borrowed_replica_not_yet_available",
      message: "The origin has not delivered this borrowed scope yet",
      category: "transient",
      retryable: true,
      recommendedAction: "retry",
    });
  }
  const entities = store.entitySchemas(shape.shapeId);
  const rows = entities.flatMap((entity) =>
    store.rows(shape.shapeId, entity.entity)
  );
  return sendJson(res, 200, {
    protocolVersion: PROTOCOL_VERSION,
    vaultId: replicaVaultId(edgeId),
    schemaEpoch: shape.schemaEpoch,
    shapes: [
      {
        shapeId: shape.shapeId,
        appId: shape.appId,
        purpose: shape.purpose,
        entities: entities.map((entity) => ({
          entity: entity.entity,
          primaryKey: entity.primaryKey,
          columns: entity.columns,
          ...(entity.hasUnavailableFields
            ? { hasUnavailableFields: true }
            : {}),
        })),
      },
    ],
    rows: rows.map((wireRow) => ({
      shapeId: shape.shapeId,
      entity: wireRow.entity,
      rowId: wireRow.rowId,
      values: wireRow.values,
      ...(wireRow.oversizedFields && wireRow.oversizedFields.length > 0
        ? { oversizedFields: wireRow.oversizedFields }
        : {}),
      ...(wireRow.rowVersion ? { rowVersion: wireRow.rowVersion } : {}),
    })),
    cursor: replicaCursor(edgeId, store.latestChangeSeq(shape.shapeId)),
    complete: true,
    outcomes: store.intentOutcomes(edgeId).flatMap((record) => {
      const outcome = wireOutcome(record);
      return outcome ? [outcome] : [];
    }),
  });
}

function wireChange(entry: BorrowedChangeEntry): Record<string, unknown> {
  if (entry.op === "delete") {
    return { op: "delete", entity: entry.entity, rowId: entry.rowId };
  }
  return {
    op: "upsert",
    entity: entry.entity,
    rowId: entry.rowId,
    values: entry.values,
    ...(entry.oversizedFields && entry.oversizedFields.length > 0
      ? { oversizedFields: entry.oversizedFields }
      : {}),
    ...(entry.rowVersion ? { rowVersion: entry.rowVersion } : {}),
  };
}

/** The tail: origin changes the audience already picked up (via the
 *  lend-write plane's sweep tail), now reaching a device past `since`. */
function handleChanges(
  res: ServerResponse,
  deps: BorrowedReplicaRouteDeps,
  row: BorrowedEdgeAuthRow,
  edgeId: string,
  since: number
): true {
  const store = deps.storeFor(row.origin_vault_id);
  const shape = store.shapeForEdge(edgeId);
  if (!shape) {
    return sendJson(res, 410, {
      error: "replica_rebootstrap_required",
      reason: "shape-changed",
    });
  }
  const page = store.changesSince(shape.shapeId, since);
  return sendJson(res, 200, {
    protocolVersion: PROTOCOL_VERSION,
    schemaEpoch: shape.schemaEpoch,
    from: replicaCursor(edgeId, since),
    to: replicaCursor(edgeId, page.cursor),
    changes: page.changes.map((change) => ({
      shapeId: shape.shapeId,
      ...wireChange(change),
    })),
    outcomes: store.intentOutcomes(edgeId).flatMap((record) => {
      const outcome = wireOutcome(record);
      return outcome ? [outcome] : [];
    }),
    hasMore: page.cursor < store.latestChangeSeq(shape.shapeId),
  });
}

async function handleIntent(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BorrowedReplicaRouteDeps,
  row: BorrowedEdgeAuthRow,
  edgeId: string
): Promise<true> {
  if (row.verbs !== "read+act") {
    return sendJson(res, 403, {
      error: "borrowed_scope_read_only",
      message: "This borrowed scope does not allow actions",
      category: "validation",
      retryable: false,
      recommendedAction: "none",
    });
  }
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: "malformed_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const intentId = typeof body.intentId === "string" ? body.intentId : "";
  const appId = typeof body.appId === "string" ? body.appId : "";
  const action = typeof body.action === "string" ? body.action : "";
  const payloadHash =
    typeof body.payloadHash === "string" ? body.payloadHash : "";
  let baseVersions: ReplicaIntentBaseVersion[];
  try {
    baseVersions = parseBaseVersions(body.baseVersions);
  } catch (error) {
    return sendJson(res, 400, {
      error: "invalid_replica_intent",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    !intentId ||
    !appId ||
    !action ||
    !("input" in body) ||
    !/^[a-f0-9]{64}$/u.test(payloadHash)
  ) {
    return sendJson(res, 400, { error: "invalid_replica_intent" });
  }
  const clientHash = expectedPayloadHash(
    appId,
    action,
    body.input,
    baseVersions
  );
  if (
    !crypto.timingSafeEqual(Buffer.from(payloadHash), Buffer.from(clientHash))
  ) {
    return sendJson(res, 400, { error: "replica_intent_hash_mismatch" });
  }
  const store = deps.storeFor(row.origin_vault_id);
  // The origin deliberately identifies the grantee as the edge, not as the
  // audience app. Re-hash that canonical identity only after authenticating
  // the device's own app-scoped payload above.
  const originHash = expectedPayloadHash(
    edgeId,
    action,
    body.input,
    baseVersions
  );
  const existing = store.intent(intentId);
  if (
    existing &&
    (existing.edgeId !== edgeId ||
      existing.action !== action ||
      existing.payloadHash !== originHash)
  ) {
    // Same concealment posture as the ordinary intent route: a UUID collision
    // is not an existence oracle and never overwrites the durable first row.
    return sendJson(res, 202, {
      protocolVersion: PROTOCOL_VERSION,
      outcome: { intentId, status: "in-flight" },
    });
  }
  const record = store.queueIntent({
    intentId,
    edgeId,
    action,
    input: body.input,
    payloadHash: originHash,
    ...(baseVersions.length > 0 ? { baseVersions } : {}),
  });
  const outcome = wireOutcome(record);
  return sendJson(res, outcome && outcome.status !== "parked" ? 200 : 202, {
    protocolVersion: PROTOCOL_VERSION,
    outcome: outcome ?? { intentId, status: "in-flight" },
  });
}

async function handleOutcomes(
  req: IncomingMessage,
  res: ServerResponse,
  deps: BorrowedReplicaRouteDeps,
  row: BorrowedEdgeAuthRow,
  edgeId: string
): Promise<true> {
  let body: Record<string, unknown>;
  try {
    body = await readJson(req);
  } catch (error) {
    return sendJson(res, 400, {
      error: "malformed_request",
      message: error instanceof Error ? error.message : String(error),
    });
  }
  if (
    !Array.isArray(body.intentIds) ||
    !body.intentIds.every((id) => typeof id === "string")
  ) {
    return sendJson(res, 400, { error: "invalid_request" });
  }
  const outcomes = deps
    .storeFor(row.origin_vault_id)
    .intentOutcomes(edgeId, body.intentIds)
    .flatMap((record) => {
      const outcome = wireOutcome(record);
      return outcome ? [outcome] : [];
    });
  return sendJson(res, 200, { protocolVersion: PROTOCOL_VERSION, outcomes });
}

export function makeBorrowedReplicaRouteHandler(
  deps: BorrowedReplicaRouteDeps
): RouteHandler {
  return async (req, res): Promise<boolean> => {
    const url = new URL(req.url ?? "/", "http://gateway.local");
    if (
      url.pathname !== BORROWED_BOOTSTRAP_PATH &&
      url.pathname !== BORROWED_CHANGES_PATH &&
      url.pathname !== BORROWED_INTENTS_PATH &&
      url.pathname !== BORROWED_OUTCOMES_PATH
    ) {
      return false;
    }
    const expectedMethod =
      url.pathname === BORROWED_INTENTS_PATH ||
      url.pathname === BORROWED_OUTCOMES_PATH
        ? "POST"
        : "GET";
    if ((req.method ?? "GET") !== expectedMethod)
      return sendJson(res, 405, { error: "method_not_allowed" });
    const deviceId = callerDeviceId(req);
    const owner = deviceId ? deps.enrollments.ownerFor(deviceId) : undefined;
    if (!deviceId || !owner)
      return sendJson(res, 403, { error: "device_identity_required" });
    const edgeId = url.searchParams.get("edgeId");
    if (!edgeId) return sendJson(res, 400, { error: "invalid_request" });
    const authorized = authorizedEdge(deps, owner, edgeId);
    if (!authorized) return notFound(res);
    if (url.pathname === BORROWED_BOOTSTRAP_PATH) {
      return handleBootstrap(res, deps, authorized.row, edgeId);
    }
    if (url.pathname === BORROWED_INTENTS_PATH) {
      return handleIntent(req, res, deps, authorized.row, edgeId);
    }
    if (url.pathname === BORROWED_OUTCOMES_PATH) {
      return handleOutcomes(req, res, deps, authorized.row, edgeId);
    }
    const since = Number(url.searchParams.get("since") ?? "0");
    if (!Number.isSafeInteger(since) || since < 0)
      return sendJson(res, 400, { error: "invalid_request" });
    return handleChanges(res, deps, authorized.row, edgeId, since);
  };
}
