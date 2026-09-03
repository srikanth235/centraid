import type { DatabaseSync } from "node:sqlite";

import { bindPartyToVault, revokePartyVaultBinding } from "@centraid/vault";

import type { VaultLink } from "./vault-link-row.js";
import { isLinkApproved, partyIdForLinkedVault } from "./vault-link-row.js";

export type LinkBindingState =
  | "bound"
  | "conflict"
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
