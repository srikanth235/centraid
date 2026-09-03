import type { DatabaseSync } from "node:sqlite";

export type ShareChannelState = "live" | "severed";

export interface ShareChannel {
  partyId: string;
  state: ShareChannelState;
  vaultId: string;
  linkedAt: string;
  revokedAt?: string;
}

interface BindingRow {
  vault_id: string;
  linked_at: string;
  revoked_at: string | null;
}

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
