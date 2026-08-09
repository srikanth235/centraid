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
import { recordShareAccessReceipt } from "../serve/share-access-receipts.js";
import type { LinkRoute } from "../serve/vault-link-row.js";
import type { EdgeRow } from "./edges-reconcile.js";
import { readEdgeRow, updateStatus } from "./edges-reconcile.js";

export async function reconcileRemoteEdge(
  db: GatewayDatabase,
  row: EdgeRow,
  origin: ShareVaultRef,
  route: LinkRoute,
  dial: PeerDial
): Promise<EdgeRow> {
  if (row.status === "completed") return row;
  updateStatus(db, row.edge_id, "in-flight", null);
  const itemIds = JSON.parse(row.scope_json ?? "[]") as string[];
  const closure = readShareClosure(origin.vault, {
    originVaultId: row.origin_vault_id,
    itemType: row.item_type,
    itemIds,
    // A remote audience is never this gateway's own owner (P1 ownership is
    // per-gateway) — every remote edge is cross-owner by construction.
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
  switch (outcome.state) {
    case "given": {
      const targetItemIds = outcome.items.map((item) => item.itemId);
      db.transaction(() => {
        db.run(
          `UPDATE share_edges
              SET target_state = 'executed', target_item_ids_json = ?, updated_at = ?
            WHERE edge_id = ?`,
          JSON.stringify(targetItemIds),
          new Date().toISOString(),
          row.edge_id
        );
        recordShareAccessReceipt(db, {
          edgeId: row.edge_id,
          ownerId: row.owner_id,
          action: "share",
          itemType: row.item_type,
          originVaultId: row.origin_vault_id,
          originItemIds: itemIds,
          audienceVaultId: row.audience_vault_id,
          audienceItemIds: targetItemIds,
        });
      });
      updateStatus(db, row.edge_id, "completed", null);
      break;
    }
    case "asked":
      updateStatus(db, row.edge_id, "parked", "awaiting recipient decision");
      break;
    case "denied":
      updateStatus(
        db,
        row.edge_id,
        "denied",
        outcome.reason ?? "recipient is not accepting gives right now"
      );
      break;
    case "not_found":
      // The peer no longer recognises this link (revoked, or never did) —
      // topology hiding forward: we get no more detail than that either.
      updateStatus(db, row.edge_id, "parked", "peer link not reachable");
      break;
    case "unreachable":
      updateStatus(
        db,
        row.edge_id,
        "parked",
        `peer unreachable: ${outcome.detail}`
      );
      break;
    case "bad_request":
      updateStatus(
        db,
        row.edge_id,
        "parked",
        `peer refused the give: ${outcome.detail}`
      );
      break;
  }
  return readEdgeRow(db, row.edge_id)!;
}
