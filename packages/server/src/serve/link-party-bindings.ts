/*
 * The link ceremony's vault-side footprint (#821). A binding is written ONLY
 * for a link approved on both sides and not revoked; revocation tombstones
 * rather than deletes, so a re-link re-lights the row; only the LOCAL side is
 * written (#750 inv. 2). Runs OUTSIDE the gateway transaction, whose rollback
 * would otherwise leave the binding standing.
 */

import type { DatabaseSync } from "node:sqlite";

import { bindPartyToVault, revokePartyVaultBinding } from "@centraid/vault";

import type { VaultLink } from "./vault-link-row.js";
import { isLinkApproved, partyIdForLinkedVault } from "./vault-link-row.js";

export type LinkBindingState =
  | "bound"
  | "conflict"
  /** R9 (#916): the link named this vault or its own party — a member is not
   *  their own peer, and the binding is refused rather than written. */
  | "self"
  | "revoked"
  | "absent"
  | "pending"
  | "no-party";

export interface LinkBindingOutcome {
  localVaultId: string;
  peerVaultId: string;
  partyId?: string;
  state: LinkBindingState;
}

export interface BindingVaultRef {
  vault: DatabaseSync;
}

export interface LinkBindingDeps {
  vaultFor: (vaultId: string) => BindingVaultRef | undefined;
  publicKeyFor?: (vaultId: string) => string | undefined;
  labelFor?: (vaultId: string) => string | undefined;
  now?: () => number;
}

/** Total and idempotent: every link state maps to a defined outcome. */
export function reconcileLinkBindings(
  link: VaultLink,
  deps: LinkBindingDeps
): LinkBindingOutcome[] {
  const stamp = new Date((deps.now ?? Date.now)()).toISOString();
  const outcomes: LinkBindingOutcome[] = [];
  for (const [localVaultId, peerVaultId] of [
    [link.vaultA, link.vaultB],
    [link.vaultB, link.vaultA],
  ] as const) {
    const local = deps.vaultFor(localVaultId);
    if (!local) continue;
    const partyId = partyIdForLinkedVault(link, peerVaultId);
    if (!partyId) {
      outcomes.push({ localVaultId, peerVaultId, state: "no-party" });
      continue;
    }
    if (link.revoked) {
      outcomes.push({
        localVaultId,
        peerVaultId,
        partyId,
        state: revokePartyVaultBinding(local.vault, {
          partyId,
          vaultId: peerVaultId,
          revokedAt: stamp,
        }),
      });
      continue;
    }
    if (!isLinkApproved(link)) {
      // No undo needed: approvals are only ever added, so a link never falls
      // back from approved to pending — only to revoked.
      outcomes.push({ localVaultId, peerVaultId, partyId, state: "pending" });
      continue;
    }
    outcomes.push({
      localVaultId,
      peerVaultId,
      partyId,
      state: bindPartyToVault(local.vault, {
        partyId,
        vaultId: peerVaultId,
        vaultPublicKey: deps.publicKeyFor?.(peerVaultId) ?? null,
        linkedAt: stamp,
        ...(mirrorName(deps, peerVaultId, partyId) === undefined
          ? {}
          : { displayName: mirrorName(deps, peerVaultId, partyId) as string }),
      }),
    });
  }
  return outcomes;
}

/**
 * WHAT THE MIRROR PARTY IS CALLED (#1014, S4).
 *
 * A link mints a party in the LOCAL vault standing for the person on the other
 * side, and every shared-with list reads that name. It used to take the peer
 * VAULT's directory label — so a household read "Family" and "Personal" where
 * it meant Bob and you.
 *
 * When this gateway mounts the peer vault — the same-gateway case, which is
 * where it was reproduced — the person's own name is right there, on the party
 * the link named. Ask it. A peer this host does not mount has told us nothing
 * but its vault label, so that is still the honest fallback: a vault name is a
 * worse name than a person's, and a better one than an id.
 */
function mirrorName(
  deps: LinkBindingDeps,
  peerVaultId: string,
  partyId: string
): string | undefined {
  const peer = deps.vaultFor(peerVaultId);
  const own = peer?.vault
    .prepare("SELECT display_name FROM core_party WHERE party_id = ?")
    .get(partyId) as { display_name?: string } | undefined;
  const person = own?.display_name?.trim();
  if (person) return person;
  return deps.labelFor?.(peerVaultId);
}
