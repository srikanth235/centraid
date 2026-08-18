/*
 * The link ceremony's vault-side footprint (issue #821).
 *
 * A vault link is gateway bookkeeping: `vault_links` says two vaults may
 * exchange, and `permissions_json.commonsPartyIds` remembers which party each
 * side acts as. None of that is visible to a vault query, so a People-band
 * question as ordinary as "is this person linked?" could not be answered from
 * the vault that holds the person. This module is the bridge: whenever a link
 * changes state, it reconciles `share_party_vault_binding` inside every side
 * of the link that lives ON THIS GATEWAY.
 *
 * Three properties it must keep, in order of how easy they are to lose:
 *
 *   1. A binding is written ONLY for a link that is approved on both sides
 *      and not revoked. A proposal awaiting the other owner's device writes
 *      nothing — half a ceremony is not a relationship.
 *   2. Revocation tombstones rather than deletes, so a later re-link re-lights
 *      the same row (the table's UNIQUE key is total; see the vault-side
 *      `party-vault-binding.ts`).
 *   3. Only the LOCAL side is written. `vaultFor` returning nothing is exactly
 *      what "that vault lives elsewhere" means (#750 invariant 2) — the peer
 *      gateway runs this same reconcile against its own copy of the link, so
 *      both ends end up holding the mirror-image binding without either
 *      reaching into the other's vault.
 *
 * The reconcile runs OUTSIDE the gateway-database transaction that changed the
 * link. Vault databases are separate connections: writing them inside a
 * gateway transaction would leave the binding standing if that transaction
 * later rolled back.
 */

import type { DatabaseSync } from "node:sqlite";

import { bindPartyToVault, revokePartyVaultBinding } from "@centraid/vault";

import type { VaultLink } from "./vault-link-row.js";
import { isLinkApproved, partyIdForLinkedVault } from "./vault-link-row.js";

export type LinkBindingState =
  | "bound"
  /** The party already holds a live binding to a different vault. */
  | "conflict"
  | "revoked"
  /** Nothing to tombstone — the link never reached both-sides approval. */
  | "absent"
  /** Approval is still one-sided; deliberately no write. */
  | "pending"
  /** The ceremony exchanged no party identity for that side. */
  | "no-party";

export interface LinkBindingOutcome {
  /** The vault on this gateway whose binding table was reconciled. */
  localVaultId: string;
  peerVaultId: string;
  partyId?: string;
  state: LinkBindingState;
}

/** All this reconcile needs of an open vault — `VaultDb` and `ShareVaultRef`
 *  both satisfy it structurally, so callers pass their live handle unchanged. */
export interface BindingVaultRef {
  vault: DatabaseSync;
}

export interface LinkBindingDeps {
  /** A vault ON THIS GATEWAY; `undefined` for one that lives elsewhere. */
  vaultFor: (vaultId: string) => BindingVaultRef | undefined;
  /** The peer vault's identity key, from the vault directory (#750 inv. 1). */
  publicKeyFor?: (vaultId: string) => string | undefined;
  /** The peer vault's label, used to name a party this vault has never seen. */
  labelFor?: (vaultId: string) => string | undefined;
  now?: () => number;
}

/**
 * Bring both sides' `share_party_vault_binding` rows in line with `link`.
 * Total and idempotent: every state of a link maps to a defined outcome, and
 * running it twice on the same link changes nothing the second time.
 */
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
      // One-sided approval is not yet a link. Note that this branch never
      // needs to UNDO a binding: approvals are only ever added, so a link
      // cannot fall back from approved to pending — only to revoked.
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
        ...(deps.labelFor?.(peerVaultId) === undefined
          ? {}
          : { displayName: deps.labelFor(peerVaultId) as string }),
      }),
    });
  }
  return outcomes;
}
