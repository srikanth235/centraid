/*
 * The AUDIENCE-side half of a D9 'refuse' reaching the origin (#726 P3
 * decision 9, the gap this closes: a refusal used to die at the audience —
 * the origin's edge stayed `parked` forever, which reads as a non-answer).
 *
 * Mirrors `peer-blob-pull.ts`'s shape on purpose: `recordPendingRefusal` runs
 * once, synchronously, inside the answer route — the owner's decision is
 * durable the instant it returns, before any network attempt — and
 * `drainPeerRefusals` is the background tick that delivers it, exactly the
 * way `drainPeerBlobPulls` delivers bytes. An unreachable origin leaves the
 * row exactly where it was; the next tick tries again. Nothing here ever
 * throws for a network condition — a parked delivery is a state, not an
 * exception the caller would have to turn into a 500.
 */

import type { GatewayDatabase } from "./gateway-db.js";
import type { PeerDial } from "./peer-edge-give-client.js";
import { denyEdgeOverPeer } from "./peer-edge-give-client.js";
import { peerViewOf } from "./vault-link-row.js";
import type { VaultLinksStore } from "./vault-links-store.js";

interface PendingRefusalRow {
  edge_id: string;
  link_id: string;
  peer_vault_id: string;
  local_vault_id: string;
}

/** Durably record "the origin must learn this edge was refused" — D9. */
export function recordPendingRefusal(
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
    `INSERT INTO peer_pending_refusals
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

export interface DrainPeerRefusalsResult {
  acknowledged: string[];
  pending: string[];
}

/** One background-worker tick: tell the origin about every refusal it hasn't heard yet. */
export async function drainPeerRefusals(input: {
  db: GatewayDatabase;
  links: VaultLinksStore;
  dial: PeerDial;
  /** Rows processed this tick; unbounded when omitted (tests). */
  limit?: number;
}): Promise<DrainPeerRefusalsResult> {
  const rows = (input.limit === undefined
    ? input.db.db.prepare("SELECT * FROM peer_pending_refusals").all()
    : input.db.db
        .prepare("SELECT * FROM peer_pending_refusals LIMIT ?")
        .all(input.limit)) as unknown as PendingRefusalRow[];
  const result: DrainPeerRefusalsResult = { acknowledged: [], pending: [] };
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
      const outcome = await denyEdgeOverPeer({
        dial: input.dial,
        route: view.route,
        edgeId: row.edge_id,
      });
      // `not_found` means the origin has nothing to acknowledge (its own edge
      // is gone, revoked, or never existed the way this row claims) —
      // retrying forever would never resolve it, so it is treated as
      // delivered.
      if (outcome.state === "acknowledged" || outcome.state === "not_found") {
        input.db.run(
          "DELETE FROM peer_pending_refusals WHERE edge_id = ?",
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
