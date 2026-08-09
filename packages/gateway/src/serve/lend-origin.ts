/*
 * The ORIGIN half of a live edge (#726 P4 §4). A snapshot edge ends when the
 * bytes land; a live edge is a standing window, so this file holds no copy of
 * anything — it re-derives the audience's view from the vault's CURRENT state
 * through the CURRENT grant on every frame.
 *
 * That is the whole reason revocation works: there is no staged projection to
 * chase down. Refusal here is one thing, said twice — the grant is revoked
 * (so `buildReplicaShapes` produces nothing at all) and the peer route's own
 * per-stream authorization (`peer-lend-route.ts`'s `authorized`) refuses the
 * stream. Neither is a fallback for the other; a partitioned audience that
 * never hears either still forgets when its lease runs out.
 */

import crypto from "node:crypto";

import { currentReplicaLogState, withReplicaSnapshot } from "@centraid/vault";
import type { Gateway as VaultGateway, ShareVaultRef } from "@centraid/vault";

import { projectReplicaPage } from "../routes/replica-projection.js";
import type { ReplicaChangeBatchWire } from "../routes/replica-projection.js";
import {
  buildReplicaShapes,
  REPLICA_MAX_VALUE_BYTES,
  shapeReplicaRow,
} from "../routes/replica-shape.js";
import type {
  ReplicaServerShape,
  ReplicaShapeWire,
} from "../routes/replica-shape.js";
import type { GatewayDatabase } from "./gateway-db.js";
import type { LendIntentPush } from "./lend-audience.js";
import type { LendScope } from "./lend-grant.js";
import { mintLendGrant, revokeLendGrant } from "./lend-grant.js";
import { executeLentIntent } from "./lend-intent.js";
import { mintLease } from "./lend-lease.js";
import type { LeaseSigner, LendLease } from "./lend-lease.js";

export interface LentEdgeRow {
  edge_id: string;
  origin_vault_id: string;
  audience_vault_id: string;
  grantee_party_id: string;
  grant_id: string;
  row_key_secret: string;
  item_type: string;
  verbs: "read" | "read+act";
  lease_expires_at: string;
  revoked_at: string | null;
  created_at: string;
  updated_at: string;
}

/** The bootstrap window, in rows. Matches the replica plane's own default. */
const BOOTSTRAP_WINDOW = 500;

export interface LendBootstrapPosition {
  entityIdx: number;
  after: string | null;
}

export type LendFrame =
  | {
      state: "bootstrap";
      shape: ReplicaShapeWire;
      schemaEpoch: string;
      rows: Array<Record<string, unknown>>;
      cursor: { epoch: string; seq: number };
      complete: boolean;
      next?: LendBootstrapPosition;
      lease: LendLease;
    }
  | {
      state: "changes";
      shapeId: string;
      batch: ReplicaChangeBatchWire;
      lease: LendLease;
    }
  | { state: "rebootstrap"; reason: string }
  /**
   * The deletion obligation. Revoked and "the grant no longer projects
   * anything" are ONE state on purpose: the audience must not be able to tell
   * a withdrawn scope from a withdrawn edge, and both oblige the same delete.
   */
  | { state: "revoked" }
  | { state: "not_found" }
  | { state: "bad_request"; detail: string };

export function readLentEdge(
  db: GatewayDatabase,
  edgeId: string
): LentEdgeRow | undefined {
  return db.db
    .prepare("SELECT * FROM lent_edges WHERE edge_id = ?")
    .get(edgeId) as LentEdgeRow | undefined;
}

export function openLentEdge(
  db: GatewayDatabase,
  origin: ShareVaultRef,
  input: {
    edgeId: string;
    originVaultId: string;
    audienceVaultId: string;
    audienceLabel: string;
    itemType: string;
    scopes: readonly LendScope[];
    verbs: "read" | "read+act";
    leaseExpiresAt: string;
  }
): LentEdgeRow {
  const existing = readLentEdge(db, input.edgeId);
  if (existing) return existing;
  const grant = mintLendGrant(origin.vault, {
    peerVaultId: input.audienceVaultId,
    peerLabel: input.audienceLabel,
    scopes: input.scopes,
    verbs: input.verbs,
  });
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO lent_edges
       (edge_id, origin_vault_id, audience_vault_id, grantee_party_id, grant_id,
        row_key_secret, item_type, verbs, lease_expires_at, revoked_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    input.edgeId,
    input.originVaultId,
    input.audienceVaultId,
    grant.granteePartyId,
    grant.grantId,
    crypto.randomBytes(32).toString("hex"),
    input.itemType,
    input.verbs,
    input.leaseExpiresAt,
    now,
    now
  );
  return readLentEdge(db, input.edgeId)!;
}

/** Close the window. Both halves, in one transaction-free act — the grant is
 *  the authority and the row is the bookkeeping; neither alone is revocation. */
export function revokeLentEdge(
  db: GatewayDatabase,
  origin: ShareVaultRef,
  edgeId: string
): LentEdgeRow | undefined {
  const row = readLentEdge(db, edgeId);
  if (!row) return undefined;
  revokeLendGrant(origin.vault, row.grant_id);
  db.run(
    "UPDATE lent_edges SET revoked_at = ?, updated_at = ? WHERE edge_id = ?",
    new Date().toISOString(),
    new Date().toISOString(),
    edgeId
  );
  return readLentEdge(db, edgeId);
}

function shapeFor(
  origin: ShareVaultRef,
  row: LentEdgeRow
): ReplicaServerShape | undefined {
  const shapes = buildReplicaShapes(origin.vault, {
    canWrite: row.verbs === "read+act",
    rememberDevice: false,
    grantee: {
      partyId: row.grantee_party_id,
      keySecret: row.row_key_secret,
    },
  });
  // One grantee, one purpose ⇒ at most one shape. Zero means the grant no
  // longer projects anything, which the audience must treat as a deletion.
  return shapes[0];
}

function wireShape(shape: ReplicaServerShape): ReplicaShapeWire {
  return {
    shapeId: shape.shapeId,
    appId: shape.appId,
    purpose: shape.purpose,
    entities: shape.entities.map((entity) => ({
      entity: entity.entity,
      primaryKey: entity.primaryKey,
      columns: [...entity.columns],
      ...(entity.hasUnavailableFields ? { hasUnavailableFields: true } : {}),
    })),
  };
}

/**
 * One bootstrap window, walked entity by entity and paged by primary key. The
 * cursor reported is the log watermark PINNED BY THE SNAPSHOT, so the tail
 * that follows replays from a point the rows are already consistent with.
 */
export function lendBootstrapFrame(
  db: GatewayDatabase,
  origin: ShareVaultRef,
  row: LentEdgeRow,
  sign: LeaseSigner,
  position?: LendBootstrapPosition
): LendFrame {
  const shape = shapeFor(origin, row);
  if (!shape) return { state: "revoked" };
  const lease = renewLease(db, row, sign);
  if (!lease) return { state: "not_found" };
  const nowMs = Date.now();
  return withReplicaSnapshot(origin.vault, (reader) => {
    const rows: Array<Record<string, unknown>> = [];
    let { entityIdx, after } = position ?? { entityIdx: 0, after: null };
    while (
      entityIdx < shape.entities.length &&
      rows.length < BOOTSTRAP_WINDOW
    ) {
      const entity = shape.entities[entityIdx]!.entity;
      const page = reader.readRows(entity, {
        ...(after ? { after } : {}),
        limit: BOOTSTRAP_WINDOW - rows.length,
        maxValueBytes: REPLICA_MAX_VALUE_BYTES,
      });
      for (const raw of page.rows) {
        const shaped = shapeReplicaRow(shape, entity, raw, nowMs);
        if (shaped) rows.push(shaped as unknown as Record<string, unknown>);
      }
      if (page.nextAfter) after = page.nextAfter;
      else {
        entityIdx += 1;
        after = null;
      }
    }
    const complete = entityIdx >= shape.entities.length;
    return {
      state: "bootstrap" as const,
      shape: wireShape(shape),
      schemaEpoch: String(reader.state.schemaEpoch),
      rows,
      cursor: reader.state.watermark,
      complete,
      ...(complete ? {} : { next: { entityIdx, after } }),
      lease,
    };
  }).value;
}

/**
 * One tail window. `projectReplicaPage` is the SAME projector the device plane
 * uses — a lent scope is a consent scope, so a row that leaves here has passed
 * exactly the filters an app's replica would have passed.
 */
export function lendChangesFrame(
  db: GatewayDatabase,
  origin: ShareVaultRef,
  row: LentEdgeRow,
  sign: LeaseSigner,
  since: { epoch: string; seq: number }
): LendFrame {
  const lease = renewLease(db, row, sign);
  if (!lease) return { state: "not_found" };
  const page = projectReplicaPage(
    origin.vault,
    {
      canWrite: row.verbs === "read+act",
      rememberDevice: false,
      grantee: { partyId: row.grantee_party_id, keySecret: row.row_key_secret },
    },
    since
  );
  if (page.shapes.length === 0) return { state: "revoked" };
  if (page.rebootstrapReason)
    return { state: "rebootstrap", reason: page.rebootstrapReason };
  return {
    state: "changes",
    shapeId: page.shapes[0]!.shapeId,
    batch: page.batch,
    lease,
  };
}

/** Every authenticated contact winds the clock forward (D8). */
function renewLease(
  db: GatewayDatabase,
  row: LentEdgeRow,
  sign: LeaseSigner
): LendLease | undefined {
  const lease = mintLease(sign, {
    edgeId: row.edge_id,
    originVaultId: row.origin_vault_id,
    audienceVaultId: row.audience_vault_id,
  });
  if (!lease) return undefined;
  db.run(
    "UPDATE lent_edges SET lease_expires_at = ?, updated_at = ? WHERE edge_id = ?",
    lease.expiresAt,
    new Date().toISOString(),
    row.edge_id
  );
  return lease;
}

/**
 * A {@link LendPull}-shaped door onto the SAME two frame builders the peer
 * route wraps. A co-hosted live edge (both vaults on one gateway) is not a
 * different mechanism — it is the same window with no wire between the halves,
 * which is D3's "locality is routing, not semantics" spelled out in code.
 */
export function localLendPull(
  db: GatewayDatabase,
  origin: ShareVaultRef,
  edgeId: string,
  sign: LeaseSigner
): (request: {
  frame: "bootstrap" | "changes";
  edgeId: string;
  position?: { entityIdx: number; after: string | null };
  since?: { epoch: string; seq: number };
}) => Promise<LendFrame> {
  return async (request) => {
    const row = readLentEdge(db, edgeId);
    if (!row || row.revoked_at !== null) return { state: "revoked" };
    return request.frame === "bootstrap"
      ? lendBootstrapFrame(
          db,
          origin,
          row,
          sign,
          request.position ?? { entityIdx: 0, after: null }
        )
      : lendChangesFrame(
          db,
          origin,
          row,
          sign,
          request.since ?? lendLogState(origin)
        );
  };
}

/** The current epoch/watermark a fresh edge should tail from. */
export function lendLogState(origin: ShareVaultRef): {
  epoch: string;
  seq: number;
} {
  return currentReplicaLogState(origin.vault).watermark;
}

/**
 * A {@link LendIntentPush}-shaped door onto `executeLentIntent` (#726 P5) —
 * the co-hosted write-back analogue of {@link localLendPull}. Same window,
 * no wire between the halves, no second answerer for "may this edge act."
 */
export function localLendIntentPush(
  db: GatewayDatabase,
  origin: ShareVaultRef,
  gateway: VaultGateway,
  edgeId: string
): LendIntentPush {
  return async (request) => {
    const row = readLentEdge(db, edgeId);
    if (!row || row.revoked_at !== null) return { state: "not_found" };
    return {
      state: "answered",
      frame: executeLentIntent(origin, gateway, row, request),
    };
  };
}
