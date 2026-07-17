/**
 * The keep-in-touch summary, derived from the vault: who is overdue to
 * reconnect with (last contact older than their cadence), which reminders are
 * coming up next (birthdays and dates with their reminder on), the most recent
 * touches you have logged, and the headline counts. A person never contacted
 * counts from when they were added, so a fresh contact reads as on-track.
 *
 * The app's own views compute Reconnect / Upcoming / Favorites client-side
 * from the `people` window; this query is the same judgment server-side —
 * used for the Activity feed and as a stable summary surface.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

const LIST_SCHEME_URI = 'https://centraid.dev/schemes/lists';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';
const DAY = 86400000;

function daysSince(iso) {
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? 0 : Math.floor((Date.now() - t) / DAY);
}

// Days until the next annual occurrence of an MM-DD, from today (0 = today).
function daysUntilMonthDay(monthDay) {
  const [m, d] = String(monthDay).split('-').map(Number);
  if (!m || !d) return 9999;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  let next = new Date(now.getFullYear(), m - 1, d);
  if (next < today) next = new Date(now.getFullYear() + 1, m - 1, d);
  return Math.round((next - today) / DAY);
}

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const window = 500;
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
    const profileRows = profiles.rows ?? [];
    const partyIds = profileRows.map((p) => p.party_id);
    if (partyIds.length === 0) {
      return {
        reconnect: [],
        upcoming: [],
        recent: [],
        counts: { all: 0, reconnect: 0, upcoming: 0, starred: 0 },
      };
    }

    const flagsScheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? ((concepts.rows ?? []).find(
          (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
        )?.concept_id ?? null)
      : null;

    const [parties, tags, dates, interactions] = await Promise.all([
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
      ctx.vault.read({
        entity: 'people.interaction',
        where: [{ column: 'deleted_at', op: 'is-null' }],
        orderBy: { column: 'occurred_at', dir: 'desc' },
        limit: 30,
        purpose,
      }),
    ]);

    const byParty = new Map();
    for (const pr of profileRows) byParty.set(pr.party_id, { profile: pr });
    for (const p of parties.rows ?? []) {
      const e = byParty.get(p.party_id);
      if (e) e.name = p.display_name;
    }
    const card = (partyId) => {
      const e = byParty.get(partyId);
      return {
        party_id: partyId,
        name: e?.name ?? '—',
        avatar_color: e?.profile?.avatar_color ?? null,
        role: e?.profile?.role ?? '',
      };
    };

    let starred = 0;
    for (const t of tags.rows ?? []) {
      if (starredConceptId != null && t.concept_id === starredConceptId) starred += 1;
    }

    const reconnect = profileRows
      .map((pr) => ({
        pr,
        over: daysSince(pr.last_contacted_at ?? pr.created_at) - pr.cadence_days,
      }))
      .filter((x) => x.over >= 0)
      .toSorted((a, b) => b.over - a.over)
      .map((x) => card(x.pr.party_id));

    const upcoming = (dates.rows ?? [])
      .filter((d) => d.reminder_on)
      .map((d) => ({ d, until: daysUntilMonthDay(d.month_day) }))
      .toSorted((a, b) => a.until - b.until)
      .map((x) => ({
        ...card(x.d.party_id),
        date_id: x.d.date_id,
        label: x.d.label,
        month_day: x.d.month_day,
      }));

    const recent = (interactions.rows ?? []).map((i) => ({
      ...card(i.party_id),
      interaction_id: i.interaction_id,
      kind: i.kind,
      text: i.body_text ?? '',
      occurred_at: i.occurred_at,
    }));

    return {
      reconnect,
      upcoming,
      recent,
      counts: {
        all: profileRows.length,
        reconnect: reconnect.length,
        upcoming: upcoming.length,
        starred,
      },
    };
  } catch (err) {
    return {
      reconnect: [],
      upcoming: [],
      recent: [],
      counts: { all: 0, reconnect: 0, upcoming: 0, starred: 0 },
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
