import { randomUUID } from "node:crypto";

import type { GatewayDatabase } from "./gateway-db.js";

/**
 * One row per EDGE, not per item (#726): three photographs placed by one
 * edge leave one receipt carrying all three item ids, never three receipts.
 */
export interface ShareAccessReceiptInput {
  edgeId?: string;
  ownerId?: string;
  action: "share" | "unshare";
  itemType: string;
  originVaultId?: string;
  originItemIds?: readonly string[];
  audienceVaultId: string;
  audienceItemIds: readonly string[];
}

/** Record one durable, replay-safe cross-vault access event. */
export function recordShareAccessReceipt(
  database: GatewayDatabase,
  input: ShareAccessReceiptInput
): string {
  if (input.edgeId) {
    const existing = database.db
      .prepare("SELECT receipt_id FROM share_access_receipts WHERE edge_id = ?")
      .get(input.edgeId) as { receipt_id: string } | undefined;
    if (existing) return existing.receipt_id;
  }
  const receiptId = randomUUID();
  database.run(
    `INSERT INTO share_access_receipts
       (receipt_id, edge_id, owner_id, action, item_type,
        origin_vault_id, origin_item_ids_json, audience_vault_id,
        audience_item_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    receiptId,
    input.edgeId ?? null,
    input.ownerId ?? null,
    input.action,
    input.itemType,
    input.originVaultId ?? null,
    input.originItemIds ? JSON.stringify(input.originItemIds) : null,
    input.audienceVaultId,
    JSON.stringify(input.audienceItemIds),
    new Date().toISOString()
  );
  return receiptId;
}
