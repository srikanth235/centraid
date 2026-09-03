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
  audiencePartyId: string;
}

export function deliverGiveLocally(input: DeliverGiveLocallyInput): EdgeRow {
  const { itemIds } = parseEdgeScope(input.row.mode, input.row.scope_json);
  let current = input.row;

  if (current.target_state !== "executed") {
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
  return applyEdgeSignal(input.db, current, input.facts, { type: "settled" });
}
