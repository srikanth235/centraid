/**
 * The sharing-plane reads People's queries make about a person, factored out
 * once the roster (people.ts), the profile (person.ts) and the summary
 * (dashboard.ts) all needed the same bounded reads over the vault's share
 * tables: who is linked to a vault of their own
 * (share.party_vault_binding — packages/vault/src/schema/share-commons.ts),
 * and which shared-space invitations are still awaiting their answer.
 *
 * WHAT IS SHARED WITH A PERSON IS NOT READ HERE (#825). The person screen
 * reads standing grants from
 * `GET /centraid/_vault/grants?partyId=` through the share kit's own door
 * (`apps/people/grant-dashboard.ts`), which answers for both seats and knows
 * about delivery — which a circle_grant × circle_member ×
 * commons_member_state join here could not.
 *
 * NOT a query itself — the dispatcher resolves a query name straight to
 * `queries/<name>.ts` (packages/server/src/engine/handlers/dispatcher.ts), so
 * a plain helper module beside the handlers is invisible to it.
 *
 * GRACEFUL DENIAL is this file's reason to exist as a seam. People's
 * `share.*` scopes are new, and on an EXISTING vault newly declared scopes are
 * parked for the owner to approve rather than auto-granted. A denial here must
 * therefore never become a consent wall over the roster: every helper catches
 * its own denial and returns `null`, meaning "the link facts are absent",
 * which callers surface as `links_available: false` / null-valued fields while
 * the rest of the answer stays whole.
 *
 * TS conversion note: the vault read surface returns `Record<string, unknown>`
 * rows (see HandlerCtx.vault), so each raw row set is cast once to a typed
 * shape (`as unknown as X[]`) at its read site.
 */

const PURPOSE = "dpv:ServiceProvision";

/** A live (or revoked) party↔vault binding row. */
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

/** One invitation sent to this person that they have not answered yet. */
export interface PendingInvite {
  invitation_id: string;
  container_label: string | null;
  capability: "read" | "read+write";
  created_at: string;
}

/** The whole sharing picture for one person, or `null` when it is unreadable. */
export interface PersonShareLinks {
  vaults: Array<{ binding_id: string; vault_id: string; linked_at: string }>;
  pending_invites: PendingInvite[];
}

/**
 * Live party↔vault bindings for a bounded set of parties — `null` when the
 * `share.party_vault_binding` read is unavailable — denied, pending owner approval, or failed. All three read the same way: the fact is absent, not false.
 * The partial unique index makes at most one live binding per party, so the
 * window is sized off the caller's party list.
 */
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

/**
 * What the sharing plane knows about one person: their live vault bindings and
 * the invitations still awaiting their answer. `null` when either read is
 * unavailable — the sharing plane is one story, and half of it would read as
 * "nothing is shared" rather than "we cannot see".
 */
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
