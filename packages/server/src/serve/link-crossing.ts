/* Sole cross-vault edge judge (#726): ONE policy for both localities; every
   refusal is not_found — refusals must never map the topology. */

import type { LinkRoute } from "./vault-link-row.js";
import { isLinkApproved } from "./vault-link-row.js";
import type { VaultLinksStore } from "./vault-links-store.js";

export interface LinkCrossingDeps {
  links: VaultLinksStore;
  ownerOf: (vaultId: string) => string | undefined;
}

export type LinkCrossing =
  | { state: "same-owner" }
  | { state: "linked"; linkId: string; route?: LinkRoute }
  | { state: "not_found" };

export function judgeEdgeCrossing(
  deps: LinkCrossingDeps,
  originVaultId: string,
  audienceVaultId: string
): LinkCrossing {
  const originOwner = deps.ownerOf(originVaultId);
  if (originOwner === undefined) return { state: "not_found" };
  if (originVaultId === audienceVaultId) return { state: "not_found" };
  const audienceOwner = deps.ownerOf(audienceVaultId);
  if (audienceOwner !== undefined && audienceOwner === originOwner)
    return { state: "same-owner" };
  const link = deps.links.findPair(originVaultId, audienceVaultId);
  if (!link || !isLinkApproved(link)) return { state: "not_found" };
  // route exists iff the audience is remote (#750).
  const route = deps.links.routeFor(audienceVaultId);
  if (audienceOwner === undefined && !route) return { state: "not_found" };
  return {
    state: "linked",
    linkId: link.linkId,
    ...(route ? { route } : {}),
  };
}
