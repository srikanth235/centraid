import type { PeerDial } from "./peer-link-client.js";
import { pushRouteAssertion } from "./peer-link-client.js";
import type { VaultLinksStore } from "./vault-links-store.js";

export const LAST_ASSERTED_ENDPOINT_META_KEY =
  "peer_route_last_asserted_endpoint";

export interface AnnounceLocalRoutesDeps {
  links: VaultLinksStore;
  dial: PeerDial;
  signAsVault: (vaultId: string, bytes: Buffer) => Buffer | undefined;
  localVaultIds: () => string[];
  route: () => { endpointId?: string; relayHints: string[] };
  log: { info: (message: string) => void; warn: (message: string) => void };
  now?: () => number;
}

export type AnnounceLocalRoutesResult = "idle" | "asserted" | "partial";

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
