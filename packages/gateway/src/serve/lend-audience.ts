/*
 * The AUDIENCE half of a live edge (#726 P4 §4/§5) — bootstrap, tail, and the
 * one deletion path.
 *
 * The stream is never the sole authority. A shape change (a narrowed mask, a
 * withdrawn table) re-bootstraps rather than being patched in place, and the
 * lease is checked by a sweep that owes nothing to the network: expiry,
 * revocation, and the audience dropping the edge itself all converge on
 * {@link dropBorrowedEdge}. That convergence is what makes revocation
 * bilateral for free — there is only one way for a borrowed shape to end, so
 * there is only one thing to get right.
 */

import type { BorrowedCas } from "./borrowed-cas.js";
import type {
  BorrowedChange,
  BorrowedRow,
  BorrowedStore,
} from "./borrowed-store.js";
import type { GatewayDatabase } from "./gateway-db.js";
import { acceptLease, parseLease } from "./lend-lease.js";
import { recordShareAccessReceipt } from "./share-access-receipts.js";

/** The origin-side frame vocabulary, as it arrives here: JSON, unvalidated. */
export type LendPull = (request: {
  frame: "bootstrap" | "changes";
  edgeId: string;
  position?: { entityIdx: number; after: string | null };
  since?: { epoch: string; seq: number };
}) => Promise<unknown>;

export interface BorrowedDeps {
  gatewayDatabase: GatewayDatabase;
  /** Per COUNTERPARTY VAULT, opened lazily by the caller. */
  storeFor: (peerVaultId: string) => BorrowedStore;
  casFor: (peerVaultId: string) => BorrowedCas;
}

export interface LendEdgeIdentity {
  edgeId: string;
  originVaultId: string;
  audienceVaultId: string;
  /** Pinned at link time — the key a lease must verify against. */
  originPublicKey: string;
  /** How this borrower NAMES the lender: "at <holder>'s vault". */
  holderLabel: string;
  itemType: string;
  /** 'read' or 'read+act' (#726 P5) — the audience's own copy of what the
   *  origin announced at `lend/open`. Defaults to 'read' for callers that
   *  predate this field (co-hosted landing, older test fixtures). */
  verbs?: "read" | "read+act";
  /** The `vault_links` row this edge rides (#726 P6 gap 2) — what a per-link
   *  byte budget is keyed on. Absent only for a hand-built identity that
   *  never went through `recordBorrowedEdge`/`identityOf` (test doubles that
   *  call `syncBorrowedEdge` directly); a real listed edge always has one. */
  linkId?: string;
}

export type LendSyncOutcome =
  | { state: "established"; shapeId: string; rows: number }
  | { state: "dropped"; reason: string }
  | { state: "unreachable"; detail: string }
  | { state: "refused"; detail: string };

interface BootstrapFrame {
  state: "bootstrap";
  shape: {
    shapeId: string;
    appId: string;
    purpose: string;
    entities: Array<{
      entity: string;
      primaryKey: string;
      columns: string[];
      hasUnavailableFields?: boolean;
    }>;
  };
  schemaEpoch: string;
  rows: BorrowedRow[];
  cursor: { epoch: string; seq: number };
  complete: boolean;
  next?: { entityIdx: number; after: string | null };
  lease: unknown;
}

function frameState(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const state = (value as Record<string, unknown>).state;
  return typeof state === "string" ? state : undefined;
}

/**
 * Accept the lease riding on a frame, or refuse the frame. An unsigned or
 * mis-signed lease is not "a frame without a lease" — it is a frame from
 * someone who cannot prove they are the vault this edge belongs to.
 */
function leaseFrom(
  frame: unknown,
  identity: LendEdgeIdentity
): string | undefined {
  const lease = parseLease((frame as { lease?: unknown } | null)?.lease);
  if (!lease) return undefined;
  return acceptLease(lease, {
    edgeId: identity.edgeId,
    originVaultId: identity.originVaultId,
    audienceVaultId: identity.audienceVaultId,
    originPublicKey: identity.originPublicKey,
  })
    ? lease.expiresAt
    : undefined;
}

/**
 * Bootstrap the scoped projection, then tail it. Returns the edge's state, so
 * a caller can put it on `share_edges` — `established`, and it STAYS there.
 * That is exactly what distinguishes a live edge from a snapshot's
 * `completed`.
 */
export async function syncBorrowedEdge(
  deps: BorrowedDeps,
  identity: LendEdgeIdentity,
  pull: LendPull
): Promise<LendSyncOutcome> {
  const store = deps.storeFor(identity.originVaultId);
  const existing = store.shapeForEdge(identity.edgeId);
  if (existing?.cursor) {
    return tailBorrowedEdge(deps, identity, pull);
  }
  return bootstrapBorrowedEdge(deps, identity, pull);
}

export async function bootstrapBorrowedEdge(
  deps: BorrowedDeps,
  identity: LendEdgeIdentity,
  pull: LendPull
): Promise<LendSyncOutcome> {
  const store = deps.storeFor(identity.originVaultId);
  let position: { entityIdx: number; after: string | null } | undefined;
  let shapeId: string | undefined;
  let cursor: { epoch: string; seq: number } | undefined;
  let rows = 0;
  for (;;) {
    let frame: unknown;
    try {
      // oxlint-disable-next-line no-await-in-loop -- genuinely sequential: each page's `position` cursor comes from the previous page, so pulls cannot run in parallel
      frame = await pull({
        frame: "bootstrap",
        edgeId: identity.edgeId,
        ...(position ? { position } : {}),
      });
    } catch (error) {
      return {
        state: "unreachable",
        detail: error instanceof Error ? error.message : String(error),
      };
    }
    const state = frameState(frame);
    if (state === "revoked" || state === "not_found") {
      return dropBorrowedEdge(deps, identity, "the lender closed this share");
    }
    if (state !== "bootstrap")
      return { state: "refused", detail: state ?? "malformed frame" };
    const page = frame as BootstrapFrame;
    const expiresAt = leaseFrom(frame, identity);
    if (!expiresAt)
      return { state: "refused", detail: "the lease did not verify" };
    if (!shapeId) {
      shapeId = page.shape.shapeId;
      cursor = page.cursor;
      store.beginBootstrap({
        shapeId,
        edgeId: identity.edgeId,
        originVaultId: identity.originVaultId,
        appId: page.shape.appId,
        purpose: page.shape.purpose,
        schemaEpoch: page.schemaEpoch,
        leaseExpiresAt: expiresAt,
        entities: page.shape.entities,
      });
    } else if (page.shape.shapeId !== shapeId) {
      // The shape moved mid-walk: restart rather than stitch two shapes into
      // one store. The stream is never the sole authority.
      return bootstrapBorrowedEdge(deps, identity, pull);
    }
    store.applyPage(page.rows);
    store.renewLease(shapeId, expiresAt);
    rows += page.rows.length;
    if (page.complete) break;
    if (!page.next)
      return { state: "refused", detail: "incomplete page named no resume" };
    position = page.next;
  }
  store.commitBootstrap(shapeId!, cursor!);
  return { state: "established", shapeId: shapeId!, rows };
}

export async function tailBorrowedEdge(
  deps: BorrowedDeps,
  identity: LendEdgeIdentity,
  pull: LendPull
): Promise<LendSyncOutcome> {
  const store = deps.storeFor(identity.originVaultId);
  const shape = store.shapeForEdge(identity.edgeId);
  if (!shape?.cursor) return bootstrapBorrowedEdge(deps, identity, pull);
  let frame: unknown;
  try {
    frame = await pull({
      frame: "changes",
      edgeId: identity.edgeId,
      since: shape.cursor,
    });
  } catch (error) {
    return {
      state: "unreachable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const state = frameState(frame);
  if (state === "revoked" || state === "not_found") {
    return dropBorrowedEdge(deps, identity, "the lender closed this share");
  }
  // A shape change is a re-bootstrap, never a patch: a narrowed mask must not
  // leave the widened columns sitting in the borrowed store.
  if (state === "rebootstrap")
    return bootstrapBorrowedEdge(deps, identity, pull);
  if (state !== "changes")
    return { state: "refused", detail: state ?? "malformed frame" };
  const expiresAt = leaseFrom(frame, identity);
  if (!expiresAt)
    return { state: "refused", detail: "the lease did not verify" };
  const batch = (
    frame as {
      batch: { changes: BorrowedChange[]; to: { epoch: string; seq: number } };
    }
  ).batch;
  store.applyChanges(shape.shapeId, batch.changes ?? [], batch.to);
  store.renewLease(shape.shapeId, expiresAt);
  return {
    state: "established",
    shapeId: shape.shapeId,
    rows: store.rowCount(shape.shapeId),
  };
}

/**
 * THE deletion path. Reached four ways — the lease expired, the origin said
 * `revoked`, the origin pushed a close, or this owner dropped the edge — and
 * it does the same thing every time: the shape goes, the bytes nothing else
 * refers to go, and a receipt records that they went. No pending-revocation
 * queue and no delivery receipt back to the origin: the obligation is
 * discharged locally or not at all.
 */
export function dropBorrowedEdge(
  deps: BorrowedDeps,
  identity: LendEdgeIdentity,
  reason: string
): LendSyncOutcome {
  const store = deps.storeFor(identity.originVaultId);
  const shape = store.shapeForEdge(identity.edgeId);
  // An edge dropped before it ever bootstrapped still discharges the
  // obligation and still receipts: "nothing was here" is an outcome, not a
  // reason to skip the record.
  if (shape) {
    const dropped = store.dropShape(shape.shapeId);
    deps.casFor(identity.originVaultId).purge(dropped.blobs);
  }
  setBorrowedEdgeState(
    deps.gatewayDatabase,
    identity.edgeId,
    "dropped",
    reason
  );
  recordShareAccessReceipt(deps.gatewayDatabase, {
    edgeId: identity.edgeId,
    action: "unshare",
    itemType: identity.itemType,
    originVaultId: identity.originVaultId,
    audienceVaultId: identity.audienceVaultId,
    audienceItemIds: [],
  });
  return { state: "dropped", reason };
}

export type BorrowedEdgeState =
  | "offered"
  | "established"
  | "parked"
  | "dropped";

interface BorrowedEdgeRow {
  edge_id: string;
  link_id: string;
  origin_vault_id: string;
  audience_vault_id: string;
  item_type: string;
  holder_label: string;
  origin_public_key: string;
  verbs: "read" | "read+act";
  state: BorrowedEdgeState;
  reason: string | null;
  updated_at: string;
}

function identityOf(row: BorrowedEdgeRow): LendEdgeIdentity {
  return {
    edgeId: row.edge_id,
    originVaultId: row.origin_vault_id,
    audienceVaultId: row.audience_vault_id,
    originPublicKey: row.origin_public_key,
    holderLabel: row.holder_label,
    itemType: row.item_type,
    verbs: row.verbs,
    linkId: row.link_id,
  };
}

/** The audience's ledger of edges lent TO it — durable before any row is. */
export function recordBorrowedEdge(
  db: GatewayDatabase,
  input: LendEdgeIdentity & { linkId: string }
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO borrowed_edges
       (edge_id, link_id, origin_vault_id, audience_vault_id, item_type,
        holder_label, origin_public_key, verbs, state, reason, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'offered', NULL, ?, ?)
     ON CONFLICT(edge_id) DO UPDATE SET
       holder_label = excluded.holder_label,
       origin_public_key = excluded.origin_public_key,
       verbs = excluded.verbs,
       updated_at = excluded.updated_at`,
    input.edgeId,
    input.linkId,
    input.originVaultId,
    input.audienceVaultId,
    input.itemType,
    input.holderLabel,
    input.originPublicKey,
    input.verbs ?? "read",
    now,
    now
  );
}

export function readBorrowedEdge(
  db: GatewayDatabase,
  edgeId: string
): LendEdgeIdentity | undefined {
  const row = db.db
    .prepare("SELECT * FROM borrowed_edges WHERE edge_id = ?")
    .get(edgeId) as BorrowedEdgeRow | undefined;
  return row ? identityOf(row) : undefined;
}

export function setBorrowedEdgeState(
  db: GatewayDatabase,
  edgeId: string,
  state: BorrowedEdgeState,
  reason: string | null
): void {
  db.run(
    "UPDATE borrowed_edges SET state = ?, reason = ?, updated_at = ? WHERE edge_id = ?",
    state,
    reason,
    new Date().toISOString(),
    edgeId
  );
}

export function liveBorrowedEdges(db: GatewayDatabase): LendEdgeIdentity[] {
  return (
    db.db
      .prepare("SELECT * FROM borrowed_edges WHERE state != 'dropped'")
      .all() as unknown as BorrowedEdgeRow[]
  ).map(identityOf);
}

/** One row of the audience's own ledger, shaped for a listing rather than a
 *  sync — the material `scopes-routes.ts` renders a borrowed row from
 *  (#726 P4 item 6). */
export interface BorrowedEdgeSummary {
  edgeId: string;
  audienceVaultId: string;
  originVaultId: string;
  holderLabel: string;
  itemType: string;
  state: BorrowedEdgeState;
  reason: string | null;
  /** 'read' or 'read+act' (#726 P5) — whether a device may write here. */
  verbs: "read" | "read+act";
  /** Last authenticated contact — a live edge's own recency, so a mount
   *  policy can prefer what is actually being used. */
  updatedAt: string;
}

/** Every live (non-dropped) edge lent TO one of these vaults. */
export function borrowedEdgesForVaults(
  db: GatewayDatabase,
  audienceVaultIds: readonly string[]
): BorrowedEdgeSummary[] {
  if (audienceVaultIds.length === 0) return [];
  const placeholders = audienceVaultIds.map(() => "?").join(",");
  return (
    db.db
      .prepare(
        `SELECT * FROM borrowed_edges
          WHERE state != 'dropped' AND audience_vault_id IN (${placeholders})
          ORDER BY updated_at DESC`
      )
      .all(...audienceVaultIds) as unknown as BorrowedEdgeRow[]
  ).map((row) => ({
    edgeId: row.edge_id,
    audienceVaultId: row.audience_vault_id,
    originVaultId: row.origin_vault_id,
    holderLabel: row.holder_label,
    itemType: row.item_type,
    state: row.state,
    reason: row.reason,
    verbs: row.verbs,
    updatedAt: row.updated_at,
  }));
}

// The write-back drain (#726 P5) lives in `lend-audience-write.ts` —
// extracted to keep this file under the repo's file-size guidance.
// Re-exported here so existing `./lend-audience.js` imports keep working.
export { drainBorrowedIntents } from "./lend-audience-write.js";
export type { LendIntentPush } from "./lend-audience-write.js";

/**
 * The sweep that makes a partitioned audience forget on schedule. It reads a
 * clock and a column — nothing about reachability — so an audience offline
 * past expiry drops the store unprompted, without ever being told to.
 */
export function sweepExpiredBorrowedEdges(
  deps: BorrowedDeps,
  now = new Date().toISOString()
): Array<{ edgeId: string; originVaultId: string }> {
  const dropped: Array<{ edgeId: string; originVaultId: string }> = [];
  for (const identity of liveBorrowedEdges(deps.gatewayDatabase)) {
    const shape = deps
      .storeFor(identity.originVaultId)
      .shapeForEdge(identity.edgeId);
    if (!shape || shape.leaseExpiresAt > now) continue;
    dropBorrowedEdge(deps, identity, "the lease expired");
    dropped.push({
      edgeId: identity.edgeId,
      originVaultId: identity.originVaultId,
    });
  }
  return dropped;
}
