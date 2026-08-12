/*
 * The durable two-phase reconciler an edge replays until it completes
 * (#726 P2 — generalizes placement-routes.ts' original single-item logic).
 * A crash can land between the two vault commits, but can never remove the
 * source first: `target_state` is the idempotent receipt-replay marker the
 * source step consults.
 *
 * One row, however many items `scope_json` carries: the target phase is
 * ONE `shareItemsToVault` call (one closure, one blob pass, one audience
 * transaction) and ONE receipt covering every item. The source phase (a
 * move) loops the per-item `moveOutOfVault` door, but needs no per-item
 * progress tracking of its own — deleting an already-deleted projected row
 * is a documented no-op (`removal.ts`), so replaying the whole loop after a
 * partial failure is safe.
 */

import type {
  moveOutOfVault,
  ProjectedItem,
  shareItemsToVault,
  ShareVaultRef,
  ShareableItemType,
} from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import { recordShareAccessReceipt } from "../serve/share-access-receipts.js";
import { parseStoredShareScope } from "../serve/share-contracts.js";

export type EdgeKind = "add" | "move";
export type EdgeMode = "snapshot";
export type EdgeStatus =
  | "queued"
  | "in-flight"
  | "established"
  | "parked"
  | "denied"
  | "revoked"
  | "completed"
  | "failed";

export interface EdgeRow {
  edge_id: string;
  created_by_device: string;
  owner_id: string;
  kind: EdgeKind;
  mode: EdgeMode;
  item_type: ShareableItemType;
  scope_json: string | null;
  origin_vault_id: string;
  audience_vault_id: string;
  verbs: "read";
  target_item_ids_json: string | null;
  target_state: "queued" | "executed";
  source_state: "not-needed" | "queued" | "executed";
  status: EdgeStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export type EdgeEvent =
  | { type: "start" }
  | { type: "target-executed"; targetItemIds: readonly string[] }
  | { type: "source-executed" }
  | { type: "complete" }
  | { type: "park"; reason: string }
  | { type: "deny"; reason: string }
  | { type: "fail"; reason: string }
  | { type: "revoke"; reason: string };

export type EdgeDeliveryOutcome =
  | { state: "given"; items: readonly ProjectedItem[] }
  | { state: "parked"; reason: string }
  | { state: "denied"; reason: string };

export interface EdgeTransport {
  deliver: (input: {
    row: EdgeRow;
    origin: ShareVaultRef;
    itemIds: readonly string[];
    crossOwner: boolean;
  }) => EdgeDeliveryOutcome | Promise<EdgeDeliveryOutcome>;
}

const EDGE_STATUS_TRANSITIONS: Readonly<
  Record<EdgeStatus, ReadonlySet<EdgeStatus>>
> = {
  queued: new Set(["in-flight", "parked", "denied", "failed", "revoked"]),
  "in-flight": new Set(["completed", "parked", "denied", "failed", "revoked"]),
  established: new Set(["completed", "failed", "revoked"]),
  parked: new Set(["in-flight", "completed", "denied", "failed", "revoked"]),
  denied: new Set(),
  revoked: new Set(),
  completed: new Set(),
  failed: new Set(),
};

export function readEdgeRow(
  db: GatewayDatabase,
  edgeId: string
): EdgeRow | undefined {
  return db.db
    .prepare("SELECT * FROM share_edges WHERE edge_id = ?")
    .get(edgeId) as EdgeRow | undefined;
}

/** The one legal state-transition door for every local and peer edge. */
export function transitionEdge(
  db: GatewayDatabase,
  edgeId: string,
  status: EdgeStatus,
  reason: string | null
): EdgeRow {
  const current = readEdgeRow(db, edgeId);
  if (!current) throw new Error(`share edge ${edgeId} does not exist`);
  if (current.status === status) return current;
  if (!EDGE_STATUS_TRANSITIONS[current.status].has(status)) {
    throw new Error(
      `illegal share edge transition ${current.status} -> ${status}`
    );
  }
  db.run(
    `UPDATE share_edges SET status = ?, reason = ?, updated_at = ?
      WHERE edge_id = ?`,
    status,
    reason,
    new Date().toISOString(),
    edgeId
  );
  return readEdgeRow(db, edgeId)!;
}

function applyEdgeEvent(
  db: GatewayDatabase,
  row: EdgeRow,
  event: EdgeEvent
): EdgeRow {
  if (event.type === "start")
    return transitionEdge(db, row.edge_id, "in-flight", null);
  if (event.type === "park")
    return transitionEdge(db, row.edge_id, "parked", event.reason);
  if (event.type === "deny")
    return transitionEdge(db, row.edge_id, "denied", event.reason);
  if (event.type === "fail")
    return transitionEdge(db, row.edge_id, "failed", event.reason);
  if (event.type === "revoke")
    return transitionEdge(db, row.edge_id, "revoked", event.reason);
  if (event.type === "complete") {
    const current = readEdgeRow(db, row.edge_id)!;
    if (
      current.target_state !== "executed" ||
      (current.kind === "move" && current.source_state !== "executed")
    )
      throw new Error("share edge cannot complete before both phases settle");
    return transitionEdge(db, row.edge_id, "completed", null);
  }
  if (event.type === "target-executed") {
    db.run(
      `UPDATE share_edges
          SET target_state = 'executed', target_item_ids_json = ?, updated_at = ?
        WHERE edge_id = ?`,
      JSON.stringify(event.targetItemIds),
      new Date().toISOString(),
      row.edge_id
    );
    return readEdgeRow(db, row.edge_id)!;
  }
  db.run(
    `UPDATE share_edges SET source_state = 'executed', updated_at = ?
      WHERE edge_id = ?`,
    new Date().toISOString(),
    row.edge_id
  );
  return readEdgeRow(db, row.edge_id)!;
}

/**
 * The one edge coordinator. A transport produces delivery facts; this reducer
 * alone owns target/source/status transitions and receipts for both local and
 * peer routes.
 */
export async function reconcileEdgeWithTransport(
  db: GatewayDatabase,
  row: EdgeRow,
  origin: ShareVaultRef,
  transport: EdgeTransport,
  move: typeof moveOutOfVault,
  crossOwner = false
): Promise<EdgeRow> {
  if (row.status === "completed") return row;
  let current = row;
  current = applyEdgeEvent(db, current, { type: "start" });
  const scope = parseStoredShareScope(current.mode, current.scope_json);
  if (scope.mode !== "snapshot") throw new Error("live edge rows are retired");
  const itemIds = scope.itemIds;

  if (current.target_state !== "executed") {
    const outcome = await transport.deliver({
      row: current,
      origin,
      itemIds,
      crossOwner,
    });
    if (outcome.state === "parked")
      return applyEdgeEvent(db, current, {
        type: "park",
        reason: outcome.reason,
      });
    if (outcome.state === "denied")
      return applyEdgeEvent(db, current, {
        type: "deny",
        reason: outcome.reason,
      });
    const targetItemIds = outcome.items.map((item) => item.itemId);
    db.transaction(() => {
      applyEdgeEvent(db, current, {
        type: "target-executed",
        targetItemIds,
      });
      recordShareAccessReceipt(db, {
        edgeId: current.edge_id,
        ownerId: current.owner_id,
        action: "share",
        itemType: current.item_type,
        originVaultId: current.origin_vault_id,
        originItemIds: itemIds,
        audienceVaultId: current.audience_vault_id,
        audienceItemIds: targetItemIds,
      });
    });
  }

  current = readEdgeRow(db, current.edge_id)!;
  if (current.kind === "move" && current.source_state !== "executed") {
    for (const itemId of itemIds) {
      move({ source: origin, itemType: current.item_type, itemId });
    }
    current = applyEdgeEvent(db, current, { type: "source-executed" });
  }

  return applyEdgeEvent(db, current, { type: "complete" });
}

/** Local transport adapter; locality changes delivery only, never semantics. */
export function localEdgeTransport(
  audience: ShareVaultRef,
  share: typeof shareItemsToVault
): EdgeTransport {
  return {
    deliver: ({ row, origin, itemIds, crossOwner }) => ({
      state: "given",
      items: share({
        origin,
        originVaultId: row.origin_vault_id,
        audience,
        itemType: row.item_type,
        itemIds,
        sharedBy: row.owner_id,
        crossOwner,
      }).items,
    }),
  };
}
