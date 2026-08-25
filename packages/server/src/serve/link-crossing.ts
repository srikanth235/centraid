/*
 * "May an edge cross from vault A to vault B?" — the ONE answerer, for both
 * localities (#726 P2 §3 + P3 decisions 1 and 6).
 *
 * D3 makes locality routing rather than semantics, so this function must not
 * branch into two policies: it asks the same two questions of every pair —
 * is this one owner's own business, and if not, is there an approved link —
 * and then reports whether the answer needs routing to act on. The
 * same-machine caller (`routes/edges-routes.ts`) ignores the route; the
 * remote caller dials it. Neither decides anything this function did not.
 *
 * Every refusal is one state, `not_found`: an unlinked vault, an unapproved
 * link, a revoked link, and a vault id that exists nowhere must be
 * indistinguishable, or the refusal itself maps the topology.
 */

import type { LinkRoute } from "./vault-link-row.js";
import { isLinkApproved } from "./vault-link-row.js";
import type { VaultLinksStore } from "./vault-links-store.js";

export interface LinkCrossingDeps {
  links: VaultLinksStore;
  /** The owner of a vault ON THIS GATEWAY; `undefined` for a vault elsewhere. */
  ownerOf: (vaultId: string) => string | undefined;
}

export type LinkCrossing =
  /** Both vaults belong to one person: owning them IS the authorization. */
  | { state: "same-owner" }
  /**
   * An approved link authorizes it. `route` is present exactly when the
   * audience is a vault elsewhere — the only difference remoteness makes.
   */
  | { state: "linked"; linkId: string; route?: LinkRoute }
  | { state: "not_found" };

export function judgeEdgeCrossing(
  deps: LinkCrossingDeps,
  originVaultId: string,
  audienceVaultId: string
): LinkCrossing {
  // An edge always LEAVES a vault this gateway holds; there is no such thing
  // as sending on someone else's behalf.
  const originOwner = deps.ownerOf(originVaultId);
  if (originOwner === undefined) return { state: "not_found" };
  if (originVaultId === audienceVaultId) return { state: "not_found" };
  const audienceOwner = deps.ownerOf(audienceVaultId);
  if (audienceOwner !== undefined && audienceOwner === originOwner)
    return { state: "same-owner" };
  const link = deps.links.findPair(originVaultId, audienceVaultId);
  if (!link || !isLinkApproved(link)) return { state: "not_found" };
  // The audience's ONE `vault_routes` row (#750 invariant 2): present exactly
  // when the audience lives elsewhere. No route and no local owner means the
  // pair names something this gateway cannot address at all.
  const route = deps.links.routeFor(audienceVaultId);
  if (audienceOwner === undefined && !route) return { state: "not_found" };
  return {
    state: "linked",
    linkId: link.linkId,
    ...(route ? { route } : {}),
  };
}
