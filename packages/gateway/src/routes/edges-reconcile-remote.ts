/*
 * The REMOTE half of the edge reconciler (#726 P3 decision 7). Same table,
 * same statuses, same receipt as `edges-reconcile.ts` — this file exists
 * because dialing a peer is inherently async and the local reconciler is
 * deliberately not, not because remote edges mean anything different.
 * `routes/edges-routes.ts` dispatches to whichever of the two a
 * `judgeEdgeCrossing` route decides it needs; both write through the SAME
 * `updateStatus`/`recordShareAccessReceipt` this file imports rather than
 * duplicating.
 *
 * Derivatives cross WITH the closure (decision 7) — `collectDerivativeBlobs`
 * reads them out of the origin's own CAS before the closure ever leaves this
 * process. Originals do not: the audience records them `remote-only`
 * (`peer_blob_pulls`, decided at the AUDIENCE'S give handler, not here) and
 * pulls them in the background. From THIS gateway's point of view the edge is
 * "given" the moment the audience accepts the closure — background byte
 * custody at the far end is that gateway's own bookkeeping, never reported
 * back over this link, and this gateway has no way to observe it.
 */

import type { ShareVaultRef } from "@centraid/vault";
import { readShareClosure } from "@centraid/vault";

import type { GatewayDatabase } from "../serve/gateway-db.js";
import { collectDerivativeBlobs } from "../serve/peer-closure-blobs.js";
import type { PeerDial } from "../serve/peer-edge-give-client.js";
import { giveEdgeOverPeer } from "../serve/peer-edge-give-client.js";
import type { LinkRoute } from "../serve/vault-link-row.js";
import type {
  EdgeDeliveryOutcome,
  EdgeRow,
  EdgeTransport,
} from "./edges-reconcile.js";
import { reconcileEdgeWithTransport } from "./edges-reconcile.js";

function remoteEdgeTransport(route: LinkRoute, dial: PeerDial): EdgeTransport {
  return {
    deliver: async ({ row, origin, itemIds }): Promise<EdgeDeliveryOutcome> => {
      const closure = readShareClosure(origin.vault, {
        originVaultId: row.origin_vault_id,
        itemType: row.item_type,
        itemIds,
        crossOwner: true,
      });
      const derivatives = collectDerivativeBlobs(origin, closure);
      const outcome = await giveEdgeOverPeer({
        dial,
        route,
        edgeId: row.edge_id,
        itemType: row.item_type,
        itemCount: itemIds.length,
        closure,
        derivatives,
      });
      if (outcome.state === "given") return outcome;
      if (outcome.state === "denied")
        return {
          state: "denied",
          reason:
            outcome.reason ?? "recipient is not accepting gives right now",
        };
      if (outcome.state === "asked")
        return { state: "parked", reason: "awaiting recipient decision" };
      if (outcome.state === "not_found")
        return { state: "parked", reason: "peer link not reachable" };
      if (outcome.state === "unreachable")
        return {
          state: "parked",
          reason: `peer unreachable: ${outcome.detail}`,
        };
      return {
        state: "parked",
        reason: `peer refused the give: ${outcome.detail}`,
      };
    },
  };
}

export async function reconcileRemoteEdge(
  db: GatewayDatabase,
  row: EdgeRow,
  origin: ShareVaultRef,
  route: LinkRoute,
  dial: PeerDial
): Promise<EdgeRow> {
  if (row.kind === "move")
    throw new Error("remote move is not an allowed edge command");
  return reconcileEdgeWithTransport(
    db,
    row,
    origin,
    remoteEdgeTransport(route, dial),
    () => {
      throw new Error("remote move is not an allowed edge command");
    },
    true
  );
}
