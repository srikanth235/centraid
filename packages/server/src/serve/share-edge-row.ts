import type { ShareableItemType } from "@centraid/vault";

import type { GatewayDatabase } from "./gateway-db.js";

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

export function readEdgeRow(
  db: GatewayDatabase,
  edgeId: string
): EdgeRow | undefined {
  return db.db
    .prepare("SELECT * FROM share_edges WHERE edge_id = ?")
    .get(edgeId) as EdgeRow | undefined;
}
