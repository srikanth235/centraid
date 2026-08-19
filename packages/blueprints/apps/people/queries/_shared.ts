/**
 * The sharing-plane reads People's queries make about a person, factored out
 * once the roster (people.ts), the profile (person.ts) and the summary
 * (dashboard.ts) all needed the same bounded joins over the vault's share
 * tables: who is linked to a vault of their own
 * (share.party_vault_binding — packages/vault/src/schema/share-commons.ts),
 * and what has been shared with them (the circle_grant × circle_member ×
 * commons_member_state join that packages/vault/src/share/commons-lifecycle.ts
 * `listCommonsGrants` runs steward-side, here scoped to one member party).
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

interface RawMembership {
  circle_id: string;
  party_id: string;
  capability?: "read" | "read+write" | null;
}

interface RawGrant {
  grant_id: string;
  circle_id: string;
  container_type: string;
  container_id: string;
  created_at: string;
}

interface RawMemberState {
  grant_id: string;
  party_id: string;
  status: "invited" | "current" | "refused";
  accepted_at?: string | null;
}

interface RawInvitation {
  invitation_id: string;
  grant_id: string;
  container_label?: string | null;
  capability: "read" | "read+write";
  status: "pending" | "accepted" | "refused";
  created_at: string;
}

/** One thing the owner has shared with this person, as the app renders it. */
export interface SharedContainer {
  grant_id: string;
  container_type: string;
  container_id: string;
  container_label: string | null;
  capability: "read" | "read+write";
  status: "invited" | "current" | "refused";
  since: string;
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
  shared_with_them: SharedContainer[];
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
 * Everything the sharing plane knows about one person: their live vault
 * bindings, the invitations still awaiting their answer, and the containers
 * shared with them. `null` when any of those reads is unavailable — the sharing
 * plane is one story, and half of it would read as "nothing is shared" rather
 * than "we cannot see".
 */
export async function readPersonShareLinks(
  vault: VaultApi,
  partyId: string
): Promise<PersonShareLinks | null> {
  try {
    const [bindings, memberships, invitations] = await Promise.all([
      vault.read({
        entity: "share.party_vault_binding",
        where: [
          { column: "party_id", op: "eq", value: partyId },
          { column: "revoked_at", op: "is-null" },
        ],
        purpose: PURPOSE,
      }),
      vault.read({
        entity: "social.circle_member",
        where: [{ column: "party_id", op: "eq", value: partyId }],
        limit: 500,
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
    const membershipRows = (memberships.rows ??
      []) as unknown as RawMembership[];
    const invitationRows = (invitations.rows ??
      []) as unknown as RawInvitation[];
    const circleIds = [...new Set(membershipRows.map((m) => m.circle_id))];

    // The commons join, member-side: their circles' live grants, kept only
    // where a roster row names them (mirrors listCommonsGrants' inner join).
    const grants = circleIds.length
      ? await vault.read({
          entity: "share.circle_grant",
          where: [
            { column: "circle_id", op: "in", value: circleIds },
            { column: "revoked_at", op: "is-null" },
          ],
          limit: 500,
          purpose: PURPOSE,
        })
      : { rows: [] };
    const grantRows = (grants.rows ?? []) as unknown as RawGrant[];
    const grantIds = grantRows.map((g) => g.grant_id);
    const states = grantIds.length
      ? await vault.read({
          entity: "share.commons_member_state",
          where: [
            { column: "grant_id", op: "in", value: grantIds },
            { column: "party_id", op: "eq", value: partyId },
          ],
          limit: 500,
          purpose: PURPOSE,
        })
      : { rows: [] };
    const stateRows = (states.rows ?? []) as unknown as RawMemberState[];

    const stateByGrant = new Map(stateRows.map((s) => [s.grant_id, s]));
    const capabilityByCircle = new Map(
      membershipRows.map((m) => [m.circle_id, m.capability ?? "read"] as const)
    );
    // The invitation is the only place a human-readable container name is
    // kept; without one the caller words the row from container_type.
    const labelByGrant = new Map(
      invitationRows.map(
        (i) => [i.grant_id, i.container_label ?? null] as const
      )
    );

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
      shared_with_them: grantRows.flatMap((grant) => {
        const state = stateByGrant.get(grant.grant_id);
        if (!state) return [];
        return [
          {
            grant_id: grant.grant_id,
            container_type: grant.container_type,
            container_id: grant.container_id,
            container_label: labelByGrant.get(grant.grant_id) ?? null,
            capability: capabilityByCircle.get(grant.circle_id) ?? "read",
            status: state.status,
            since: state.accepted_at ?? grant.created_at,
          },
        ];
      }),
    };
  } catch {
    return null;
  }
}
