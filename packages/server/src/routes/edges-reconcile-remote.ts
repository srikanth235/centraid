/*
 * The PEER transport of a `deliver-give` effect (#726 P3 decision 7,
 * reshaped by #750 abstraction 5). Same edge, same statuses, same receipt as
 * the local transport — this file exists because dialing a peer is inherently
 * async, not because a remote edge means anything different (D3).
 *
 * Both transports are selected by `share-effect-executor.ts` from ONE
 * `deliver-give` effect and report through ONE reducer, so a peer outcome can
 * no longer invent a status the local path never uses.
 *
 * Derivatives cross WITH the closure — `collectDerivativeBlobs` reads them
 * out of the origin's own CAS before the closure leaves this process.
 * Originals do not: the audience records them as `pull-blob` effects (decided
 * at the AUDIENCE's give handler, not here) and pulls them in the background.
 * From THIS gateway's point of view the edge is "given" the moment the
 * audience accepts the closure; byte custody at the far end is that gateway's
 * own bookkeeping, never reported back over this link.
 */

import type { ShareVaultRef } from "@centraid/vault";
import { readShareClosure } from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import { collectDerivativeBlobs } from "../serve/peer-closure-blobs.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import { giveEdgeOverPeer } from "../serve/peer-edge-give-client.js";
import type { EdgeFacts, EdgeSignal } from "../serve/share-coordinator.js";
import type { EdgeRow } from "../serve/share-edge-row.js";
import { applyEdgeSignal } from "../serve/share-edge-store.js";
import { parseEdgeScope } from "../serve/share-scope.js";
import type { LinkRoute } from "../serve/vault-link-row.js";

export interface DeliverGiveOverPeerInput {
  db: GatewayDatabase;
  row: EdgeRow;
  facts: EdgeFacts;
  origin: ShareVaultRef;
  route: LinkRoute;
  dial: PeerDial;
}

export async function deliverGiveOverPeer(
  input: DeliverGiveOverPeerInput
): Promise<EdgeRow> {
  const { itemIds } = parseEdgeScope(input.row.mode, input.row.scope_json);
  const closure = readShareClosure(input.origin.vault, {
    originVaultId: input.row.origin_vault_id,
    itemType: input.row.item_type,
    itemIds,
    // A remote audience is never this gateway's own owner (P1 ownership is
    // per-gateway) — every remote edge is cross-owner by construction.
    crossOwner: true,
  });
  const derivatives = collectDerivativeBlobs(input.origin, closure);
  const outcome = await giveEdgeOverPeer({
    dial: input.dial,
    route: input.route,
    edgeId: input.row.edge_id,
    itemType: input.row.item_type,
    itemCount: itemIds.length,
    closure,
    derivatives,
  });
  return applyEdgeSignal(input.db, input.row, input.facts, signalFor(outcome));
}

/** Every peer answer is a STATE, never an exception (#726 P3 decision 9). */
function signalFor(
  outcome: Awaited<ReturnType<typeof giveEdgeOverPeer>>
): EdgeSignal {
  switch (outcome.state) {
    case "given":
      return {
        type: "target-projected",
        targetItemIds: outcome.items.map((item) => item.itemId),
      };
    case "asked":
      return { type: "give-asked" };
    case "denied":
      return {
        type: "give-denied",
        reason: outcome.reason ?? "recipient is not accepting gives right now",
      };
    case "not_found":
      // The peer no longer recognises this link (revoked, or never did) —
      // topology hiding forward: we get no more detail than that either.
      return { type: "give-parked", reason: "peer link not reachable" };
    case "unreachable":
      return {
        type: "give-parked",
        reason: `peer unreachable: ${outcome.detail}`,
      };
    case "bad_request":
      return {
        type: "give-parked",
        reason: `peer refused the give: ${outcome.detail}`,
      };
  }
}
