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
        ...(deps.labelFor?.(peerVaultId) === undefined
          ? {}
          : { displayName: deps.labelFor(peerVaultId) as string }),
      }),
    });
  }
  return outcomes;
}
