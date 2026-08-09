/*
 * The ORIGIN-side half of a lend revoke reaching an unreachable AUDIENCE
 * (#726 P6 gap 1). Mirrors `peer-refusal-relay.ts`'s shape on purpose:
 * `recordPendingLendClose` runs once, synchronously, inside `closeLiveEdge` —
 * the revoke is already fully effective locally by the time this row lands
 * (`lent_edges.revoked_at` is set and the grant is revoked, so a later pull
 * answers `not_found` regardless) — and `drainPendingLendCloses` is the
 * background tick that delivers the courtesy push, exactly the way
 * `drainPeerRefusals` delivers a D9 refusal. An unreachable audience leaves
 * the row exactly where it was; the next tick tries again. Nothing here ever
 * throws for a network condition — a parked delivery is a state, not an
 * exception the caller would have to turn into a 500.
 *
 * This is delivery, not authority: the audience's OWN sweep already converges
 * on the same `dropBorrowedEdge` the moment its lease expires or its next
 * pull answers `revoked`/`not_found` (#726 P4 D8). This relay only makes that
 * happen SOONER when a peer is reachable, never a second way for the window
 * to close.
 */

import type { GatewayDatabase } from "./gateway-db.js";
import { closeLendOverPeer } from "./lend-client.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { peerViewOf } from "./vault-link-row.js";
import type { VaultLinksStore } from "./vault-links-store.js";

interface PendingLendCloseRow {
  edge_id: string;
  link_id: string;
  peer_vault_id: string;
  local_vault_id: string;
}

/** Durably record "the audience must learn this edge was closed" — #726 P6 gap 1. */
export function recordPendingLendClose(
  db: GatewayDatabase,
  input: {
    edgeId: string;
    linkId: string;
    peerVaultId: string;
    localVaultId: string;
  }
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO peer_pending_lend_closes
       (edge_id, link_id, peer_vault_id, local_vault_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (edge_id) DO NOTHING`,
    input.edgeId,
    input.linkId,
    input.peerVaultId,
    input.localVaultId,
    now,
    now
  );
}

export interface DrainPendingLendClosesResult {
  acknowledged: string[];
  pending: string[];
}

/** One background-worker tick: tell every unreachable audience its window closed. */
export async function drainPendingLendCloses(input: {
  db: GatewayDatabase;
  links: VaultLinksStore;
  dial: PeerDial;
  /** Rows processed this tick; unbounded when omitted (tests). */
  limit?: number;
}): Promise<DrainPendingLendClosesResult> {
  const rows = (input.limit === undefined
    ? input.db.db.prepare("SELECT * FROM peer_pending_lend_closes").all()
    : input.db.db
        .prepare("SELECT * FROM peer_pending_lend_closes LIMIT ?")
        .all(input.limit)) as unknown as PendingLendCloseRow[];
  const result: DrainPendingLendClosesResult = {
    acknowledged: [],
    pending: [],
  };
  // Every row names a DIFFERENT edge — independent notify-and-delete, no
  // shared ordering — so the ticks run concurrently rather than one row at a
  // time.
  await Promise.all(
    rows.map(async (row) => {
      const link = input.links.get(row.link_id);
      const view = link ? peerViewOf(link, row.local_vault_id) : undefined;
      if (!view) {
        result.pending.push(row.edge_id);
        return;
      }
      const outcome = await closeLendOverPeer({
        dial: input.dial,
        route: view.route,
        edgeId: row.edge_id,
      });
      // `not_found` means the audience already has nothing to acknowledge (it
      // dropped the edge itself in the meantime) — retrying forever would
      // never resolve it, so it is treated as delivered.
      if (outcome.state === "closed" || outcome.state === "not_found") {
        input.db.run(
          "DELETE FROM peer_pending_lend_closes WHERE edge_id = ?",
          row.edge_id
        );
        result.acknowledged.push(row.edge_id);
      } else {
        result.pending.push(row.edge_id);
      }
    })
  );
  return result;
}
