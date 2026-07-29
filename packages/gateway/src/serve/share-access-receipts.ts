import { randomUUID } from "node:crypto";

import type { GatewayDatabase } from "./gateway-db.js";

export interface ShareAccessReceiptInput {
  linkToken?: string;
  memberId?: string;
  action: "share" | "unshare";
  itemType: string;
  originVaultId?: string;
  originItemId?: string;
  audienceVaultId: string;
  audienceItemId: string;
}

/** Record one durable, replay-safe household access event. */
export function recordShareAccessReceipt(
  database: GatewayDatabase,
  input: ShareAccessReceiptInput
): string {
  if (input.linkToken) {
    const existing = database.db
      .prepare(
        "SELECT receipt_id FROM share_access_receipts WHERE link_token = ?"
      )
      .get(input.linkToken) as { receipt_id: string } | undefined;
    if (existing) return existing.receipt_id;
  }
  const receiptId = randomUUID();
  database.run(
    `INSERT INTO share_access_receipts
       (receipt_id, link_token, member_id, action, item_type,
        origin_vault_id, origin_item_id, audience_vault_id,
        audience_item_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    receiptId,
    input.linkToken ?? null,
    input.memberId ?? null,
    input.action,
    input.itemType,
    input.originVaultId ?? null,
    input.originItemId ?? null,
    input.audienceVaultId,
    input.audienceItemId,
    new Date().toISOString()
  );
  return receiptId;
}
