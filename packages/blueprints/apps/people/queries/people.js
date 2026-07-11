/**
 * The circle as a bounded recent window: the CRM people are the rows of
 * people.profile (each a 1:1 enrichment of a canonical core.party), newest
 * first, caller-sized (default 200). Each row is decorated with its party's
 * display name, its circle (one circles-scheme tag, the same mechanism Docs
 * folders use), its canonical favorite star (the flags-scheme tag on the
 * party, issue #274), and its active reminder dates so the sidebar can derive
 * Reconnect / Upcoming / Favorites client-side exactly like the prototype.
 * `truncated` means older people exist beyond the window — grow it or search.
 *
 * Everything comes from the vault; this app holds no rows of its own. A
 * consent denial is a first-class outcome (vaultDenied), rendered as the
 * "ask the owner for access" state.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

const CIRCLE_SCHEME_URI = 'https://centraid.dev/schemes/circles';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const window = Math.min(Math.max(Number(input?.limit) || 200, 20), 2000);
  try {
    const [profiles, concepts, schemes] = await Promise.all([
      ctx.vault.read({
        entity: 'people.profile',
        orderBy: { column: 'created_at', dir: 'desc' },
        limit: window,
        purpose,
      }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
      ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
    ]);

    // Circles are owner-curated SKOS concepts — small and unbounded.
    const circleScheme = (schemes.rows ?? []).find((s) => s.uri === CIRCLE_SCHEME_URI);
    const circleConcepts = (concepts.rows ?? []).filter(
      (c) => circleScheme && c.scheme_id === circleScheme.scheme_id,
    );
    const circles = circleConcepts
      .map((c) => ({ circle_id: c.concept_id, name: c.pref_label }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name)));
    const circleConceptIds = new Set(circleConcepts.map((c) => c.concept_id));
    const flagsScheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? ((concepts.rows ?? []).find(
          (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
        )?.concept_id ?? null)
      : null;

    const profileRows = profiles.rows ?? [];
    const partyIds = profileRows.map((p) => p.party_id);
    if (partyIds.length === 0) return { people: [], circles, truncated: false, window };

    const [parties, tags, dates] = await Promise.all([
      ctx.vault.read({
        entity: 'core.party',
        where: [{ column: 'party_id', op: 'in', value: partyIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.tag',
        where: [
          { column: 'target_type', op: 'eq', value: 'core.party' },
          { column: 'target_id', op: 'in', value: partyIds },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: 'people.important_date',
        where: [{ column: 'party_id', op: 'in', value: partyIds }],
        purpose,
      }),
    ]);

    const nameById = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const circleByParty = new Map();
    const starredParties = new Set();
    for (const t of tags.rows ?? []) {
      if (circleConceptIds.has(t.concept_id)) circleByParty.set(t.target_id, t.concept_id);
      if (starredConceptId != null && t.concept_id === starredConceptId)
        starredParties.add(t.target_id);
    }
    const remindersByParty = new Map();
    for (const d of dates.rows ?? []) {
      if (!d.reminder_on) continue;
      const arr = remindersByParty.get(d.party_id) ?? [];
      arr.push({ date_id: d.date_id, label: d.label, month_day: d.month_day });
      remindersByParty.set(d.party_id, arr);
    }

    const people = profileRows.map((pr) => ({
      party_id: pr.party_id,
      name: nameById.get(pr.party_id) ?? '—',
      role: pr.role ?? '',
      avatar_color: pr.avatar_color ?? null,
      cadence_days: pr.cadence_days,
      last_contacted_at: pr.last_contacted_at ?? null,
      created_at: pr.created_at,
      circle_id: circleByParty.get(pr.party_id) ?? null,
      starred: starredParties.has(pr.party_id),
      reminders: remindersByParty.get(pr.party_id) ?? [],
    }));
    return { people, circles, truncated: profileRows.length >= window, window };
  } catch (err) {
    return { people: [], circles: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
