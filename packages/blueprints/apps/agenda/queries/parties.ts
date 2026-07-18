/**
 * The invite directory: the people the create-event picker can invite as
 * attendees. Just canonical `core.party` rows of kind `person`, projected to
 * `{ party_id, name, is_you }` with the owner (the vault's `owner_party_id`)
 * sorted first and flagged — the app holds no roster of its own. Agents, orgs
 * and groups are left out: an invitation is a commitment asked of a person.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders it
 * as the "ask the owner for access" state.
 */
interface RawParty {
  party_id: string;
  display_name?: string;
  [k: string]: unknown;
}

export default async ({ ctx }: HandlerArgs) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    // The owner is the implicit `me` (same source Tally reads) — everyone
    // else in the directory is a peer who could be invited.
    const [vaultRes, partiesRes] = await Promise.all([
      ctx.vault.read({ entity: 'core.vault', purpose }),
      ctx.vault.read({
        entity: 'core.party',
        where: [{ column: 'kind', op: 'eq', value: 'person' }],
        purpose,
      }),
    ]);
    const me = ((vaultRes.rows ?? [])[0]?.owner_party_id as string | undefined) ?? null;
    const parties = ((partiesRes.rows ?? []) as unknown as RawParty[])
      .map((p) => ({
        party_id: p.party_id,
        name: p.display_name ?? 'Guest',
        is_you: p.party_id === me,
      }))
      .toSorted(
        (a, b) =>
          (b.is_you ? 1 : 0) - (a.is_you ? 1 : 0) || String(a.name).localeCompare(String(b.name)),
      );
    return { parties, me };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { parties: [], me: null, vaultDenied: { code: e.code, message: e.message } };
  }
};
