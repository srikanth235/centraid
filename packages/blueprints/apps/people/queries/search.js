/**
 * People search as a vault projection: three FTS5 indexes do the matching —
 * the party's name (core.party), the role line (people.profile) and the
 * owner's notes (knowledge.annotation on the party) — so the app never pulls a
 * whole table to grep it. The union of matched parties is filtered to the CRM
 * people (those with a people_profile), then decorated into the same row shape
 * the `people` window uses, plus the vault's hit snippet. Name matches rank
 * first, then role, then notes.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

const LIST_SCHEME_URI = 'https://centraid.dev/schemes/lists';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { people: [] };
  try {
    const [byName, byRole, byNote] = await Promise.all([
      ctx.vault.search({ entity: 'core.party', query: term, limit: 50, purpose }),
      ctx.vault.search({ entity: 'people.profile', query: term, limit: 50, purpose }),
      ctx.vault.search({ entity: 'knowledge.annotation', query: term, limit: 50, purpose }),
    ]);

    // Ranked, de-duped party ids: name hits first, then role, then notes.
    const snippetByParty = new Map();
    const order = [];
    const consider = (partyId, snippet) => {
      if (!partyId) return;
      if (!snippetByParty.has(partyId)) {
        snippetByParty.set(partyId, snippet ?? '');
        order.push(partyId);
      } else if (!snippetByParty.get(partyId) && snippet) {
        snippetByParty.set(partyId, snippet);
      }
    };
    for (const r of byName.rows ?? []) consider(r.party_id, r._snippet);
    for (const r of byRole.rows ?? []) consider(r.party_id, r._snippet);
    for (const r of byNote.rows ?? [])
      if (r.target_type === 'core.party') consider(r.target_id, r._snippet);

    if (order.length === 0) return { people: [] };

    const [profiles, parties, tags, concepts, schemes] = await Promise.all([
      ctx.vault.read({
        entity: 'people.profile',
        where: [{ column: 'party_id', op: 'in', value: order }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.party',
        where: [{ column: 'party_id', op: 'in', value: order }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.tag',
        where: [
          { column: 'target_type', op: 'eq', value: 'core.party' },
          { column: 'target_id', op: 'in', value: order },
        ],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
      ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
    ]);

    const profileByParty = new Map((profiles.rows ?? []).map((p) => [p.party_id, p]));
    const nameById = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const listScheme = (schemes.rows ?? []).find((s) => s.uri === LIST_SCHEME_URI);
    const listConceptIds = new Set(
      (concepts.rows ?? [])
        .filter((c) => listScheme && c.scheme_id === listScheme.scheme_id)
        .map((c) => c.concept_id),
    );
    const flagsScheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? ((concepts.rows ?? []).find(
          (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
        )?.concept_id ?? null)
      : null;
    const listByParty = new Map();
    const starredParties = new Set();
    for (const t of tags.rows ?? []) {
      if (listConceptIds.has(t.concept_id)) listByParty.set(t.target_id, t.concept_id);
      if (starredConceptId != null && t.concept_id === starredConceptId)
        starredParties.add(t.target_id);
    }

    const people = order
      .filter((id) => profileByParty.has(id))
      .map((id) => {
        const pr = profileByParty.get(id);
        return {
          party_id: id,
          name: nameById.get(id) ?? '—',
          role: pr.role ?? '',
          avatar_color: pr.avatar_color ?? null,
          cadence_days: pr.cadence_days,
          last_contacted_at: pr.last_contacted_at ?? null,
          created_at: pr.created_at,
          list_id: listByParty.get(id) ?? null,
          starred: starredParties.has(id),
          reminders: [],
          snippet: snippetByParty.get(id) ?? '',
        };
      });
    return { people };
  } catch (err) {
    return { people: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
