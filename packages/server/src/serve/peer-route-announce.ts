/*
 * Production route-assertion wiring (#750 invariant 3; #726 P3
 * decision 4's "eager, not lazy").
 *
 * When this gateway's EndpointId becomes known — first endpoint start,
 * rotation of the endpoint key, or recovery onto a new machine — every peer's
 * cached route for every LOCAL vault is stale. This module signs a
 * `RouteClaim` per local vault with that vault's own identity seed and pushes
 * it to every linked peer, then remembers the announced EndpointId in
 * `gateway_meta` so an unchanged endpoint costs nothing on the next boot.
 *
 * Best-effort by design: an offline or refusing peer is LOGGED and the meta
 * key is left unset, so the whole announcement re-runs on the next endpoint
 * start and on every peer-plane sweep tick until every peer has heard it —
 * the assertion is idempotent and carries its own timestamp, so re-sending is
 * always safe (a peer that already applied it answers `stale`, which counts
 * as delivered).
 */

import type { PeerDial } from "./peer-link-client.js";
import { pushRouteAssertion } from "./peer-link-client.js";
import type { VaultLinksStore } from "./vault-links-store.js";

/** `gateway_meta` key holding the last EndpointId every peer has heard. */
export const LAST_ASSERTED_ENDPOINT_META_KEY =
  "peer_route_last_asserted_endpoint";

export interface AnnounceLocalRoutesDeps {
  links: VaultLinksStore;
  dial: PeerDial;
  /** `VaultRegistry.signAsVault` — sign as the LOCAL vault whose route moved. */
  signAsVault: (vaultId: string, bytes: Buffer) => Buffer | undefined;
  /** Every vault mounted on THIS gateway right now. */
  localVaultIds: () => string[];
  /** The gateway's current dial route; no endpoint yet means nothing to say. */
  route: () => { endpointId?: string; relayHints: string[] };
  log: { info: (message: string) => void; warn: (message: string) => void };
  now?: () => number;
}

export type AnnounceLocalRoutesResult =
  /** Endpoint unknown, unchanged since the last full delivery, or no peers. */
  | "idle"
  /** Every linked peer heard the new route; the meta key now pins it. */
  | "asserted"
  /** At least one peer did not hear it — retried on the next start/tick. */
  | "partial";

/**
 * Announce this gateway's current EndpointId to every linked peer of every
 * local vault, once per endpoint change. Never throws for a network
 * condition — `pushRouteAssertion` already folds an unreachable peer into an
 * `offline` outcome per target.
 */
export async function announceLocalRoutes(
  deps: AnnounceLocalRoutesDeps
): Promise<AnnounceLocalRoutesResult> {
  const route = deps.route();
  const endpointId = route.endpointId;
  if (endpointId === undefined) return "idle";
  const db = deps.links.gatewayDatabase;
  const last = db.db
    .prepare("SELECT value FROM gateway_meta WHERE key = ?")
    .get(LAST_ASSERTED_ENDPOINT_META_KEY) as { value?: string } | undefined;
  if (last?.value === endpointId) return "idle";
  let delivered = 0;
  let undelivered = 0;
  // Local vaults are independent claims — push them all concurrently, the
  // same posture `pushRouteAssertion` already takes across a vault's peers.
  const pushes = await Promise.all(
    deps.localVaultIds().map(async (vaultId) => ({
      vaultId,
      outcomes: await pushRouteAssertion({
        links: deps.links,
        request: deps.dial.request,
        signAsVault: deps.signAsVault,
        route: { vaultId, endpointId, relayHints: route.relayHints },
        ...(deps.now === undefined ? {} : { now: deps.now }),
        endpointTicketFor: deps.dial.endpointTicketFor,
      }),
    }))
  );
  for (const { vaultId, outcomes } of pushes) {
    for (const outcome of outcomes) {
      // `stale` means the peer already holds an equal-or-newer route — heard.
      if (outcome.state === "accepted" || outcome.state === "stale") {
        delivered += 1;
      } else {
        undelivered += 1;
        deps.log.warn(
          `route assertion for ${vaultId} did not reach ${outcome.peerVaultId} ` +
            `(${outcome.state}); will retry on the next endpoint start or sweep tick`
        );
      }
    }
  }
  if (undelivered > 0) return "partial";
  // Everything (possibly nothing) delivered: pin the endpoint so the next
  // boot with the same identity does not re-dial every peer.
  db.run(
    `INSERT INTO gateway_meta (key, value) VALUES (?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    LAST_ASSERTED_ENDPOINT_META_KEY,
    endpointId
  );
  if (delivered > 0) {
    deps.log.info(
      `route assertions delivered to ${delivered} peer link${delivered === 1 ? "" : "s"} for endpoint ${endpointId.slice(0, 10)}…`
    );
  }
  return "asserted";
}
