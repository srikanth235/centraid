// The one door applying a share-coordinator transition DURABLY (#750): every
// share_edges status change goes through `applyEdgeSignal` — no second UPDATE
// anywhere. State, access receipt, and effects commit in ONE transaction, so
// "durable before network" holds by construction, not by write ordering.

import type { GatewayDatabase } from "./gateway-db.js";
import { recordShareAccessReceipt } from "./share-access-receipts.js";
import { reduceEdge } from "./share-coordinator.js";
import type { EdgeFacts, EdgeSignal, EdgeState } from "./share-coordinator.js";
import type { EdgeRow } from "./share-edge-row.js";
import { readEdgeRow } from "./share-edge-row.js";
import { enqueueShareEffect } from "./share-effects.js";
import { parseEdgeScope, parseTargetItemIds } from "./share-scope.js";

export function edgeStateOf(row: EdgeRow): EdgeState {
  return {
    status: row.status,
    targetState: row.target_state,
    sourceState: row.source_state,
    targetItemIds: row.target_item_ids_json
      ? parseTargetItemIds(row.target_item_ids_json)
      : null,
    reason: row.reason,
  };
}

export function edgeFactsOf(row: EdgeRow): EdgeFacts {
  return { edgeId: row.edge_id, kind: row.kind };
}

/** Returns the post-commit row, so callers never re-read (or see an unauthorized state). */
export function applyEdgeSignal(
  db: GatewayDatabase,
  row: EdgeRow,
  facts: EdgeFacts,
  signal: EdgeSignal
): EdgeRow {
  const outcome = reduceEdge(facts, edgeStateOf(row), signal);
  if (!outcome.changed) return row;
  const next = outcome.state;
  db.transaction(() => {
    db.run(
      `UPDATE share_edges
          SET status = ?, target_state = ?, source_state = ?,
              target_item_ids_json = ?, reason = ?, updated_at = ?
        WHERE edge_id = ?`,
      next.status,
      next.targetState,
      next.sourceState,
      next.targetItemIds ? JSON.stringify(next.targetItemIds) : null,
      next.reason,
      new Date().toISOString(),
      row.edge_id
    );
    if (signal.type === "target-projected") {
      // One receipt per EDGE (edge_id UNIQUE — a replayed projection returns
      // the existing receipt), same transaction as the state that earned it.
      // Origin scope PARSED, never cast: a durable audit refuses a malformed
      // scope loudly instead of recording an empty one.
      recordShareAccessReceipt(db, {
        edgeId: row.edge_id,
        ownerId: row.owner_id,
        action: "share",
        itemType: row.item_type,
        originVaultId: row.origin_vault_id,
        originItemIds: parseEdgeScope(row.mode, row.scope_json).itemIds,
        audienceVaultId: row.audience_vault_id,
        audienceItemIds: next.targetItemIds ?? [],
      });
    }
    for (const effect of outcome.effects) enqueueShareEffect(db, effect);
  });
  return readEdgeRow(db, row.edge_id) ?? row;
}
