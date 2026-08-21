/*
 * The CHANNEL is not a new table (issue #825). "Can this vault reach that
 * person, and over which peer vault" was already answered by
 * `share_party_vault_binding` (#731) plus the pending-invitation fact; this
 * module reframes those rows as one channel state so the grant plane never
 * has to ask two tables the same question — and so a grant's fulfillment
 * state can be read against a channel rather than against a transport.
 *
 * The three states, in the order they are decided:
 *   - `live`     — a live binding: there is a vault to deliver into now.
 *   - `invited`  — no live binding, but a pending commons invitation stands.
 *                  The peer has been asked; nothing may be delivered yet.
 *   - `severed`  — only a revoked binding remains. The two were once linked,
 *                  and that memory is deliberately not the same as "never".
 * No binding and no pending invitation at all is `null`: not a channel in any
 * state, just a person this vault has never reached.
 */

import type { DatabaseSync } from "node:sqlite";

export type ShareChannelState = "invited" | "live" | "severed";

export interface ShareChannel {
  partyId: string;
  state: ShareChannelState;
  /** The peer vault to deliver into. Absent only for an `invited` channel
   *  whose invitation was addressed by party before the peer's vault id was
   *  known. */
  vaultId?: string;
  /** When the binding behind this channel was made, when there is one. */
  linkedAt?: string;
  /** When it was severed, for `severed`. */
  revokedAt?: string;
}

interface BindingRow {
  vault_id: string;
  linked_at: string;
  revoked_at: string | null;
}

/**
 * The binding this vault would use for a party: the live one, else the most
 * recent revoked one. `share_party_vault_binding` allows at most one LIVE row
 * per party (partial unique index), so the first branch is unambiguous.
 */
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

/** The channel to a person, or `null` when this vault has never reached them. */
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
