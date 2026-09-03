/*
 * LOCAL transport of `deliver-give` (#726 P2, #750 ab5; the only transport
 * since #825). No state machine here — every status goes through
 * `applyEdgeSignal`. CRASH INVARIANT: the audience projection commits (and
 * earns its receipt) before a move deletes the source; replay resumes from
 * `target_state`; deleting an already-deleted projected row is a documented
 * no-op (`removal.ts`).
 */

import { grantPlacementAuthority } from "@centraid/vault";
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
  /**
   * The party an edge's placement runs as (#916, adversarial review WEAK).
   * `shareItemsToVault` now demands a LIVE `share_authority` in the ORIGIN over
   * every item, naming the party the rows are being placed FOR — for an edge,
   * the audience vault's own party. It is passed in rather than read here: the
   * registry already knows it, and this file does not reach vault tables.
   */
  audiencePartyId: string;
}

/** Project the scope into the audience vault; release the source for a move. */
export function deliverGiveLocally(input: DeliverGiveLocallyInput): EdgeRow {
  const { itemIds } = parseEdgeScope(input.row.mode, input.row.scope_json);
  let current = input.row;

  if (current.target_state !== "executed") {
    // Record the owner's agreement in the ORIGIN VAULT before placing: the
    // edge row lives in `gateway.db`, which the placement gate cannot read
    // (#916).
    grantPlacementAuthority(input.origin.vault, {
      itemType: current.item_type,
      itemIds,
      audiencePartyId: input.audiencePartyId,
      grantedAt: new Date().toISOString(),
    });
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
      authority: {
        principalKind: "person",
        principalId: input.audiencePartyId,
        verb: "view",
      },
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
