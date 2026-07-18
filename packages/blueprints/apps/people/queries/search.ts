/**
 * People search as a vault projection: three FTS5 indexes do the matching —
 * the party's name (core.party), the role line (people.profile) and the
 * owner's notes (knowledge.annotation on the party) — so the app never pulls a
 * whole table to grep it. The union of matched parties is filtered to the CRM
 * people (those with a people_profile), then decorated into the same row shape
 * the `people` window uses, plus the vault's hit snippet. Name matches rank
 * first, then role, then notes.
 *
 * TS conversion note: the vault read/search surface returns
 * `Record<string, unknown>` rows (see HandlerCtx.vault), so each raw row set is
 * cast once to a typed shape (`as unknown as X[]`) at its read site. Handler
 * logic is otherwise byte-for-byte the pre-conversion JS.
 */

interface PartyHit {
  party_id?: string;
  _snippet?: string;
}

interface NoteHit {
  target_type?: string;
  target_id?: string;
  _snippet?: string;
}

interface RawProfile {
  party_id: string;
  role?: string | null;
  avatar_color?: string | null;
  cadence_days: number;
  last_contacted_at?: string | null;
  created_at: string;
}

interface RawParty {
  party_id: string;
  display_name: string;
}

interface RawTag {
  concept_id: string;
  target_id: string;
}

interface RawConcept {
  concept_id: string;
  scheme_id: string;
  notation?: string;
}

interface RawScheme {
  uri: string;
  scheme_id: string;
}

const LIST_SCHEME_URI = 'https://centraid.dev/schemes/lists';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

export default async ({ input, ctx }: HandlerArgs) => {
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
    const snippetByParty = new Map<string, string>();
    const order: string[] = [];
    const consider = (partyId: string | undefined, snippet: string | undefined) => {
      if (!partyId) return;
      if (!snippetByParty.has(partyId)) {
        snippetByParty.set(partyId, snippet ?? '');
        order.push(partyId);
      } else if (!snippetByParty.get(partyId) && snippet) {
        snippetByParty.set(partyId, snippet);
      }
    };
    for (const r of (byName.rows ?? []) as unknown as PartyHit[]) consider(r.party_id, r._snippet);
    for (const r of (byRole.rows ?? []) as unknown as PartyHit[]) consider(r.party_id, r._snippet);
    for (const r of (byNote.rows ?? []) as unknown as NoteHit[])
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

    const profileRows = (profiles.rows ?? []) as unknown as RawProfile[];
    const partyRows = (parties.rows ?? []) as unknown as RawParty[];
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const conceptRows = (concepts.rows ?? []) as unknown as RawConcept[];
    const schemeRows = (schemes.rows ?? []) as unknown as RawScheme[];

    const profileByParty = new Map<string, RawProfile>(
      profileRows.map((p) => [p.party_id, p] as const),
    );
    const nameById = new Map<string, string>(
      partyRows.map((p) => [p.party_id, p.display_name] as const),
    );
    const listScheme = schemeRows.find((s) => s.uri === LIST_SCHEME_URI);
    const listConceptIds = new Set<string>(
      conceptRows
        .filter((c) => listScheme && c.scheme_id === listScheme.scheme_id)
        .map((c) => c.concept_id),
    );
    const flagsScheme = schemeRows.find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? (conceptRows.find((c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred')
          ?.concept_id ?? null)
      : null;
    const listByParty = new Map<string, string>();
    const starredParties = new Set<string>();
    for (const t of tagRows) {
      if (listConceptIds.has(t.concept_id)) listByParty.set(t.target_id, t.concept_id);
      if (starredConceptId != null && t.concept_id === starredConceptId)
        starredParties.add(t.target_id);
    }

    const people = order
      .filter((id) => profileByParty.has(id))
      .map((id) => {
        const pr = profileByParty.get(id)!;
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
    const e = err as { code?: string; message?: string };
    return { people: [], vaultDenied: { code: e.code, message: e.message } };
  }
};
