/*
 * The LOCAL transport of a `deliver-give` effect (#726 P2, reshaped by #750
 * abstraction 5): both vaults are open in this process, so "delivery" is a
 * direct call into `@centraid/vault`'s share/move doors.
 *
 * It owns no state machine. Every status this file used to write by hand now
 * goes through `applyEdgeSignal` → `share-coordinator.ts`, exactly as the
 * peer transport's does — locality decides ROUTING, never semantics (D3).
 * What remains here is the genuinely local part: which vault calls to make,
 * in which order.
 *
 * That order is the invariant a crash can land inside of: the audience
 * projection ALWAYS commits (and earns its receipt) before a move deletes the
 * source, and `target_state` is what a replay resumes from. One row, however
 * many items the scope carries: the target phase is ONE `shareItemsToVault`
 * call and ONE receipt; the source phase loops the per-item `moveOutOfVault`
 * door but needs no progress tracking of its own, because deleting an
 * already-deleted projected row is a documented no-op (`removal.ts`).
 */

import type {
  moveOutOfVault,
  shareItemsToVault,
  ShareVaultRef,
} from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import type { EdgeFacts } from "../serve/share-coordinator.js";
import type { EdgeRow } from "../serve/share-edge-row.js";
import { applyEdgeSignal } from "../serve/share-edge-store.js";
import { parseEdgeScope } from "../serve/share-scope.js";

export interface DeliverGiveLocallyInput {
  db: GatewayDatabase;
  row: EdgeRow;
  facts: EdgeFacts;
  origin: ShareVaultRef;
  audience: ShareVaultRef;
  share: typeof shareItemsToVault;
  move: typeof moveOutOfVault;
}

/**
 * Project the scope into the audience vault and, for a move, release the
 * source. Throws only for a genuine vault failure — the executor turns that
 * into a parked edge whose effect the next tick retries.
 */
export function deliverGiveLocally(input: DeliverGiveLocallyInput): EdgeRow {
  const { itemIds } = parseEdgeScope(input.row.mode, input.row.scope_json);
  let current = input.row;

  if (current.target_state !== "executed") {
    const result = input.share({
      origin: input.origin,
      originVaultId: current.origin_vault_id,
      audience: input.audience,
      itemType: current.item_type,
      itemIds,
      sharedBy: current.owner_id,
      // Threat 8: a co-hosted CROSS-owner give gates the origin's
      // `media.location` policy inside `readShareClosure`. Same-owner gives
      // (Work→Personal) are unaffected.
      crossOwner: input.facts.crossOwner,
    });
    current = applyEdgeSignal(input.db, current, input.facts, {
      type: "target-projected",
      targetItemIds: result.items.map((item) => item.itemId),
    });
  }

  if (current.kind === "move" && current.source_state !== "executed") {
    for (const itemId of itemIds) {
      input.move({
        source: input.origin,
        itemType: current.item_type,
        itemId,
      });
    }
    current = applyEdgeSignal(input.db, current, input.facts, {
      type: "source-released",
    });
  }
  // A pass that found both halves already executed (replay after a crash)
  // still has to end the edge — the reducer decides whether it is ended.
  return applyEdgeSignal(input.db, current, input.facts, { type: "settled" });
}
