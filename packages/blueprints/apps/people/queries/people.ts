/**
 * The people window as a bounded recent view: the CRM people are the rows of
 * people.profile (each a 1:1 enrichment of a canonical core.party), newest
 * first, caller-sized (default 200). Each row is decorated with its party's
 * display name, its list (one lists-scheme tag, the same mechanism Docs
 * folders use), its canonical favorite star (the flags-scheme tag on the
 * party, issue #274), and its active reminder dates so the sidebar can derive
 * Reconnect / Upcoming / Favorites client-side exactly like the prototype.
 * `truncated` means older people exist beyond the window — grow it or search.
 *
 * Everything comes from the vault; this app holds no rows of its own. A
 * consent denial is a first-class outcome (vaultDenied), rendered as the
 * "ask the owner for access" state.
 *
 * TS conversion note: the vault read surface returns `Record<string, unknown>`
 * rows (see HandlerCtx.vault), so each raw row set is cast once to a typed
 * shape (`as unknown as X[]`) at its read site. Handler logic is otherwise
 * byte-for-byte the pre-conversion JS.
 */

interface RawProfile {
  party_id: string;
  created_at: string;
  cadence_days: number;
  role?: string | null;
  avatar_color?: string | null;
  last_contacted_at?: string | null;
}

interface RawConcept {
  concept_id: string;
  scheme_id: string;
  pref_label?: string;
  notation?: string;
}

interface RawScheme {
  uri: string;
  scheme_id: string;
}

interface RawParty {
  party_id: string;
  display_name: string;
}

interface RawTag {
  concept_id: string;
  target_id: string;
}

interface RawDate {
  party_id: string;
  reminder_on?: number | boolean | null;
  date_id: string;
  label: string;
  month_day: string;
}

interface Reminder {
  date_id: string;
  label: string;
  month_day: string;
}

const LIST_SCHEME_URI = 'https://centraid.dev/schemes/lists';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

export default async ({ input, ctx }: HandlerArgs) => {
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

    const conceptRows = (concepts.rows ?? []) as unknown as RawConcept[];
    const schemeRows = (schemes.rows ?? []) as unknown as RawScheme[];

    // Lists are owner-curated SKOS concepts — small and unbounded.
    const listScheme = schemeRows.find((s) => s.uri === LIST_SCHEME_URI);
    const listConcepts = conceptRows.filter(
      (c) => listScheme && c.scheme_id === listScheme.scheme_id,
    );
    const lists = listConcepts
      .map((c) => ({ list_id: c.concept_id, name: c.pref_label }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name)));
    const listConceptIds = new Set<string>(listConcepts.map((c) => c.concept_id));
    const flagsScheme = schemeRows.find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? (conceptRows.find((c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred')
          ?.concept_id ?? null)
      : null;

    const profileRows = (profiles.rows ?? []) as unknown as RawProfile[];
    const partyIds = profileRows.map((p) => p.party_id);
    if (partyIds.length === 0) return { people: [], lists, truncated: false, window };

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
        where: [
          { column: 'party_id', op: 'in', value: partyIds },
          { column: 'deleted_at', op: 'is-null' },
        ],
        purpose,
      }),
    ]);

    const partyRows = (parties.rows ?? []) as unknown as RawParty[];
    const tagRows = (tags.rows ?? []) as unknown as RawTag[];
    const dateRows = (dates.rows ?? []) as unknown as RawDate[];

    const nameById = new Map<string, string>(
      partyRows.map((p) => [p.party_id, p.display_name] as const),
    );
    const listByParty = new Map<string, string>();
    const starredParties = new Set<string>();
    for (const t of tagRows) {
      if (listConceptIds.has(t.concept_id)) listByParty.set(t.target_id, t.concept_id);
      if (starredConceptId != null && t.concept_id === starredConceptId)
        starredParties.add(t.target_id);
    }
    const remindersByParty = new Map<string, Reminder[]>();
    for (const d of dateRows) {
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
      list_id: listByParty.get(pr.party_id) ?? null,
      starred: starredParties.has(pr.party_id),
      reminders: remindersByParty.get(pr.party_id) ?? [],
    }));
    return { people, lists, truncated: profileRows.length >= window, window };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { people: [], lists: [], vaultDenied: { code: e.code, message: e.message } };
  }
};
