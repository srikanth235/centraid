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
import { ShareEffectsStore } from "./share-effects.js";
import { peerViewOf } from "./vault-link-row.js";
import type { VaultLinksStore } from "./vault-links-store.js";

interface PendingRefusalRow {
  effect_id: string;
  edge_id: string;
  link_id: string;
  peer_vault_id: string;
  local_vault_id: string;
  attempts: number;
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
  new ShareEffectsStore(db).enqueue({
    edgeId: input.edgeId,
    kind: "notify-refusal",
    localVaultId: input.localVaultId,
    peerVaultId: input.peerVaultId,
    payload: { linkId: input.linkId },
  });
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
  const effects = new ShareEffectsStore(input.db);
  const rows = effects
    .list({
      kind: "notify-refusal",
      active: true,
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    })
    .flatMap((effect): PendingRefusalRow[] =>
      effect.kind === "notify-refusal"
        ? [
            {
              effect_id: effect.effectId,
              edge_id: effect.edgeId,
              link_id: effect.payload.linkId,
              peer_vault_id: effect.peerVaultId,
              local_vault_id: effect.localVaultId,
              attempts: effect.attempts,
            },
          ]
        : []
    );
  const result: DrainPeerRefusalsResult = { acknowledged: [], pending: [] };
  // Every row names a DIFFERENT edge — independent notify-and-delete, no
  // shared ordering — so the ticks run concurrently rather than one row at a
  // time.
  await Promise.all(
    rows.map(async (row) => {
      const link = input.links.get(row.link_id);
      const view = link ? peerViewOf(link, row.local_vault_id) : undefined;
      if (!view) {
        effects.transition(row.effect_id, "parked", {
          attempted: true,
          retryAt: retryAt(row.attempts),
        });
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
        effects.transition(row.effect_id, "executed", { attempted: true });
        result.acknowledged.push(row.edge_id);
      } else {
        effects.transition(row.effect_id, "parked", {
          attempted: true,
          retryAt: retryAt(row.attempts),
        });
        result.pending.push(row.edge_id);
      }
    })
  );
  return result;
}

function retryAt(attempts: number): number {
  return Date.now() + Math.min(60_000 * 2 ** attempts, 15 * 60_000);
}
