// Channel state per party (#825) — #731 binding rows + pending invitation:
// live = deliverable; invited = invitation stands, nothing delivers;
// severed = revoked only; neither = null.

import type { DatabaseSync } from "node:sqlite";

export type ShareChannelState = "invited" | "live" | "severed";

export interface ShareChannel {
  partyId: string;
  state: ShareChannelState;
  /** Absent only for `invited`. */
  vaultId?: string;
  linkedAt?: string;
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

function pendingInvitationVaultId(
  db: DatabaseSync,
  partyId: string
): { member_vault_id: string | null } | undefined {
  return db
    .prepare(
      `SELECT member_vault_id FROM share_commons_invitation
        WHERE member_party_id = ? AND status = 'pending'
        ORDER BY created_at DESC, invitation_id
        LIMIT 1`
    )
    .get(partyId) as { member_vault_id: string | null } | undefined;
}

export function channelForParty(
  db: DatabaseSync,
  partyId: string
): ShareChannel | null {
  const binding = bindingForParty(db, partyId);
  if (binding && binding.revoked_at === null) {
    return {
      partyId,
      state: "live",
      vaultId: binding.vault_id,
      linkedAt: binding.linked_at,
    };
  }
  const invitation = pendingInvitationVaultId(db, partyId);
  if (invitation) {
    const vaultId = invitation.member_vault_id ?? binding?.vault_id;
    return {
      partyId,
      state: "invited",
      ...(vaultId === undefined ? {} : { vaultId }),
      ...(binding === undefined ? {} : { linkedAt: binding.linked_at }),
    };
  }
  if (binding) {
    return {
      partyId,
      state: "severed",
      vaultId: binding.vault_id,
      linkedAt: binding.linked_at,
      ...(binding.revoked_at === null ? {} : { revokedAt: binding.revoked_at }),
    };
  }
  return null;
}
