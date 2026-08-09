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
  shareItemsToVault,
  ShareVaultRef,
  ShareableItemType,
} from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import { recordShareAccessReceipt } from "../serve/share-access-receipts.js";

export type EdgeKind = "add" | "move";
export type EdgeMode = "snapshot" | "live";
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
  verbs: "read" | "read+act";
  target_item_ids_json: string | null;
  target_state: "queued" | "executed";
  source_state: "not-needed" | "queued" | "executed";
  status: EdgeStatus;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export function readEdgeRow(
  db: GatewayDatabase,
  edgeId: string
): EdgeRow | undefined {
  return db.db
    .prepare("SELECT * FROM share_edges WHERE edge_id = ?")
    .get(edgeId) as EdgeRow | undefined;
}

/**
 * Also called from `edges-reconcile-remote.ts` and `peer-edge-give-route.ts`
 * — same statuses, same table, whether the audience is local or across a
 * link (#726 P3 decision 7: locality decides routing only).
 * @public
 */
export function updateStatus(
  db: GatewayDatabase,
  edgeId: string,
  status: EdgeStatus,
  reason: string | null
): void {
  db.run(
    `UPDATE share_edges SET status = ?, reason = ?, updated_at = ?
      WHERE edge_id = ?`,
    status,
    reason,
    new Date().toISOString(),
    edgeId
  );
}

export function reconcileEdge(
  db: GatewayDatabase,
  row: EdgeRow,
  origin: ShareVaultRef,
  audience: ShareVaultRef,
  share: typeof shareItemsToVault,
  move: typeof moveOutOfVault,
  /**
   * True for a co-hosted CROSS-OWNER edge (father→daughter, both vaults on
   * this gateway) — threat 8: gates the origin's `media.location` policy
   * against `exif_json` inside `readShareClosure`. Same-owner edges default
   * false and are unaffected.
   */
  crossOwner = false
): EdgeRow {
  if (row.status === "completed") return row;
  let current = row;
  updateStatus(db, current.edge_id, "in-flight", null);
  const itemIds = JSON.parse(current.scope_json ?? "[]") as string[];

  if (current.target_state !== "executed") {
    const result = share({
      origin,
      originVaultId: current.origin_vault_id,
      audience,
      itemType: current.item_type,
      itemIds,
      sharedBy: current.owner_id,
      crossOwner,
    });
    const targetItemIds = result.items.map((item) => item.itemId);
    db.transaction(() => {
      db.run(
        `UPDATE share_edges
            SET target_state = 'executed', target_item_ids_json = ?, updated_at = ?
          WHERE edge_id = ?`,
        JSON.stringify(targetItemIds),
        new Date().toISOString(),
        current.edge_id
      );
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
    db.run(
      `UPDATE share_edges SET source_state = 'executed', updated_at = ?
        WHERE edge_id = ?`,
      new Date().toISOString(),
      current.edge_id
    );
  }

  updateStatus(db, current.edge_id, "completed", null);
  return readEdgeRow(db, current.edge_id)!;
}
