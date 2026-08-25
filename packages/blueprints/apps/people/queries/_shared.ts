/*
 * Not a query (dispatcher maps a name to `queries/<name>.ts`). WHAT IS SHARED WITH A PERSON IS NOT READ HERE (#825) — grants go through `GET /centraid/_vault/grants?partyId=`.
 * GRACEFUL DENIAL: catch → `null` ("facts absent"), never a consent wall over the roster.
 */

const PURPOSE = "dpv:ServiceProvision";

export interface BindingRow {
  binding_id: string;
  party_id: string;
  vault_id: string;
  linked_at: string;
}

interface RawInvitation {
  invitation_id: string;
  grant_id: string;
  container_label?: string | null;
  capability: "read" | "read+write";
  status: "pending" | "accepted" | "refused";
  created_at: string;
}

export interface PendingInvite {
  invitation_id: string;
  container_label: string | null;
  capability: "read" | "read+write";
  created_at: string;
}

export interface PersonShareLinks {
  vaults: Array<{ binding_id: string; vault_id: string; linked_at: string }>;
  pending_invites: PendingInvite[];
}

export async function readLiveBindings(
  vault: VaultApi,
  partyIds: string[]
): Promise<BindingRow[] | null> {
  if (partyIds.length === 0) return [];
  try {
    const bindings = await vault.read({
      entity: "share.party_vault_binding",
      where: [
        { column: "party_id", op: "in", value: partyIds },
        { column: "revoked_at", op: "is-null" },
      ],
      limit: Math.min(partyIds.length * 2, 2000),
      purpose: PURPOSE,
    });
    return (bindings.rows ?? []) as unknown as BindingRow[];
  } catch {
    return null;
  }
}

export async function readPersonShareLinks(
  vault: VaultApi,
  partyId: string
): Promise<PersonShareLinks | null> {
  try {
    const [bindings, invitations] = await Promise.all([
      vault.read({
        entity: "share.party_vault_binding",
        where: [
          { column: "party_id", op: "eq", value: partyId },
          { column: "revoked_at", op: "is-null" },
        ],
        purpose: PURPOSE,
      }),
      vault.read({
        entity: "share.commons_invitation",
        where: [{ column: "member_party_id", op: "eq", value: partyId }],
        limit: 500,
        purpose: PURPOSE,
      }),
    ]);
    const bindingRows = (bindings.rows ?? []) as unknown as BindingRow[];
    const invitationRows = (invitations.rows ??
      []) as unknown as RawInvitation[];

    return {
      vaults: bindingRows.map((b) => ({
        binding_id: b.binding_id,
        vault_id: b.vault_id,
        linked_at: b.linked_at,
      })),
      pending_invites: invitationRows
        .filter((i) => i.status === "pending")
        .map((i) => ({
          invitation_id: i.invitation_id,
          container_label: i.container_label ?? null,
          capability: i.capability,
          created_at: i.created_at,
        })),
    };
  } catch {
    return null;
  }
}
