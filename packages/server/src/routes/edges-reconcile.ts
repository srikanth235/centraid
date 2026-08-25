/*
 * LOCAL transport of `deliver-give` (#726 P2, #750 ab5; the only transport
 * since #825). No state machine here — every status goes through
 * `applyEdgeSignal`. CRASH INVARIANT: the audience projection commits (and
 * earns its receipt) before a move deletes the source; replay resumes from
 * `target_state`; deleting an already-deleted projected row is a documented
 * no-op (`removal.ts`).
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

/** Project the scope into the audience vault; release the source for a move. */
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
      // Threat 8's cross-owner gate has nothing to gate: edges are same-owner;
      // grants to another person ride the grant plane's own closure + policy.
      crossOwner: false,
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
  // A replay that found both halves executed still ends the edge here.
  return applyEdgeSignal(input.db, current, input.facts, { type: "settled" });
}
