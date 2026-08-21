/*
 * The one door that applies a `share-coordinator.ts` transition DURABLY
 * (issue #750 abstraction 5). Every status change on `share_edges` in this
 * repo goes through `applyEdgeSignal` — there is no second UPDATE anywhere.
 *
 * The whole outcome commits in ONE transaction: the moved state, the access
 * receipt a projection earns, and every effect the transition emitted. That
 * is what makes "durable before network" true by construction rather than by
 * remembering to order two writes — an effect can never exist for a
 * transition that did not commit, and a committed transition can never lose
 * the obligation it created.
 */

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

/**
 * Reduce, then commit. Returns the row as it now stands, so callers never
 * have to re-read (and never see a state the reducer did not authorize).
 */
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
      // One receipt per EDGE regardless of item count, in the same
      // transaction as the state that earned it — `edge_id` is UNIQUE, so a
      // replayed projection returns the existing receipt instead of a second.
      // The origin scope is PARSED here, never cast: a durable audit must
      // refuse a malformed scope loudly rather than record an empty one.
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
