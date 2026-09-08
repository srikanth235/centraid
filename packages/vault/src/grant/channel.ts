// Channel state per party, read off #731's binding rows alone: live =
// deliverable, severed = the link ended, never linked = null.
//
// A third state used to sit between them — `invited`, meaning a share had
// minted a commons claim and was waiting for the person to arrive with a
// vault. #903 retired that bootstrap: the People link ceremony is the one
// thing that opens a channel, so there is no longer a way to be part-way
// through opening one. Every state here is now a fact about a binding.

import type { DatabaseSync } from "node:sqlite";

export type ShareChannelState = "live" | "severed";

export interface ShareChannel {
  partyId: string;
  state: ShareChannelState;
  /** Always known: both states are read off a binding row that names it. */
  vaultId: string;
  linkedAt: string;
  revokedAt?: string;
}

interface BindingRow {
  vault_id: string;
  linked_at: string;
  revoked_at: string | null;
}

/** Live else most-recent revoked; ≤1 live row per party. */
function bindingForParty(
  db: DatabaseSync,
  partyId: string
): BindingRow | undefined {
  return db
    .prepare(
      `SELECT vault_id, linked_at, revoked_at
         FROM share_party_vault_binding
        WHERE party_id = ?
        ORDER BY (revoked_at IS NULL) DESC, linked_at DESC, binding_id
        LIMIT 1`
    )
    .get(partyId) as BindingRow | undefined;
}

export function channelForParty(
  db: DatabaseSync,
  partyId: string
): ShareChannel | null {
  const binding = bindingForParty(db, partyId);
  if (!binding) return null;
  if (binding.revoked_at === null)
    return {
      partyId,
      state: "live",
      vaultId: binding.vault_id,
      linkedAt: binding.linked_at,
    };
  return {
    partyId,
    state: "severed",
    vaultId: binding.vault_id,
    linkedAt: binding.linked_at,
    revokedAt: binding.revoked_at,
  };
}
