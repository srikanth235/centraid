import { randomUUID } from "node:crypto";

import type { GatewayDatabase } from "./gateway-db.js";

/**
 * The durable HISTORY of same-owner placements (#726 P2, kept as history by
 * #928 A7): one row per PLACEMENT, not per item — three photographs moved by
 * one act leave one receipt carrying all three item ids.
 *
 * `edge_id` is the caller's own placement token and is UNIQUE, which is what
 * makes a replayed placement exactly-once at this boundary: the phone's outbox
 * retries, and a retry reads the recorded row instead of placing again.
 */
export interface ShareAccessReceiptInput {
  edgeId?: string;
  ownerId?: string;
  action: "share" | "unshare";
  /** Which act this was; absent on rows written before #928. */
  placementKind?: "add" | "move";
  createdByDevice?: string;
  itemType: string;
  originVaultId?: string;
  originItemIds?: readonly string[];
  audienceVaultId: string;
  audienceItemIds: readonly string[];
}

export interface ShareAccessReceiptRow {
  receiptId: string;
  edgeId: string | null;
  ownerId: string | null;
  action: "share" | "unshare";
  placementKind: "add" | "move" | null;
  createdByDevice: string | null;
  itemType: string;
  originVaultId: string | null;
  originItemIds: string[];
  audienceVaultId: string;
  audienceItemIds: string[];
  createdAt: string;
}

interface RawReceipt {
  receipt_id: string;
  edge_id: string | null;
  owner_id: string | null;
  action: string;
  placement_kind: string | null;
  created_by_device: string | null;
  item_type: string;
  origin_vault_id: string | null;
  origin_item_ids_json: string | null;
  audience_vault_id: string;
  audience_item_ids_json: string;
  created_at: string;
}

const SELECT = `SELECT receipt_id, edge_id, owner_id, action, placement_kind,
    created_by_device, item_type, origin_vault_id, origin_item_ids_json,
    audience_vault_id, audience_item_ids_json, created_at
  FROM share_access_receipts`;

/** A malformed id list is refused loudly; an audit must not record an empty one. */
function ids(raw: string | null): string[] {
  if (raw === null) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some((id) => typeof id !== "string"))
    throw new Error("share access receipt holds a malformed item id list");
  return parsed as string[];
}

function toRow(raw: RawReceipt): ShareAccessReceiptRow {
  return {
    receiptId: raw.receipt_id,
    edgeId: raw.edge_id,
    ownerId: raw.owner_id,
    action: raw.action as "share" | "unshare",
    placementKind: raw.placement_kind as "add" | "move" | null,
    createdByDevice: raw.created_by_device,
    itemType: raw.item_type,
    originVaultId: raw.origin_vault_id,
    originItemIds: ids(raw.origin_item_ids_json),
    audienceVaultId: raw.audience_vault_id,
    audienceItemIds: ids(raw.audience_item_ids_json),
    createdAt: raw.created_at,
  };
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
       (receipt_id, edge_id, owner_id, action, placement_kind,
        created_by_device, item_type, origin_vault_id, origin_item_ids_json,
        audience_vault_id, audience_item_ids_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    receiptId,
    input.edgeId ?? null,
    input.ownerId ?? null,
    input.action,
    input.placementKind ?? null,
    input.createdByDevice ?? null,
    input.itemType,
    input.originVaultId ?? null,
    input.originItemIds ? JSON.stringify(input.originItemIds) : null,
    input.audienceVaultId,
    JSON.stringify(input.audienceItemIds),
    new Date().toISOString()
  );
  return receiptId;
}

export function readShareAccessReceipt(
  database: GatewayDatabase,
  edgeId: string
): ShareAccessReceiptRow | undefined {
  const raw = database.db.prepare(`${SELECT} WHERE edge_id = ?`).get(edgeId) as
    | RawReceipt
    | undefined;
  return raw ? toRow(raw) : undefined;
}

export function listShareAccessReceipts(
  database: GatewayDatabase,
  ownerId: string
): ShareAccessReceiptRow[] {
  return (
    database.db
      .prepare(
        `${SELECT} WHERE owner_id = ? ORDER BY created_at DESC LIMIT 200`
      )
      .all(ownerId) as unknown as RawReceipt[]
  ).map(toRow);
}
