/*
 * The `share_edges` ROW — its shape and its one reader. A leaf on purpose:
 * the reducer (`share-coordinator.ts`), the durable applier
 * (`share-edge-store.ts`), both transports and every route that answers an
 * edge all need this type, and none of them should have to import a
 * transport to get it (#750 abstraction 5).
 *
 * The statuses live here as one union, not as strings sprinkled through
 * routes: which of them may follow which is `share-coordinator.ts`'s single
 * answer, and this module deliberately holds no transition logic at all.
 */

import type { ShareableItemType } from "@centraid/vault";

import type { GatewayDatabase } from "./gateway-db.js";

export type EdgeKind = "add" | "move";
/** `snapshot` is the only mode there is — no live lending (#731). */
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
  /** Provenance only — WHICH device acted. Listing scopes by owner (#750). */
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

export function readEdgeRow(
  db: GatewayDatabase,
  edgeId: string
): EdgeRow | undefined {
  return db.db
    .prepare("SELECT * FROM share_edges WHERE edge_id = ?")
    .get(edgeId) as EdgeRow | undefined;
}
