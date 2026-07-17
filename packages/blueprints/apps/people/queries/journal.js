/**
 * The journal, newest first: the owner-level entries you write (a mood and a
 * line about the day) folded together with the interactions you have logged as
 * automatic entries — the way Monica turns a logged call into a journal line.
 * Owner entries carry their chosen mood; auto entries carry the person they
 * were with so the view can render their monogram.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [entries, interactions] = await Promise.all([
      ctx.vault.read({
        entity: 'people.journal_entry',
        where: [{ column: 'deleted_at', op: 'is-null' }],
        orderBy: { column: 'created_at', dir: 'desc' },
        limit: 200,
        purpose,
      }),
      ctx.vault.read({
        entity: 'people.interaction',
        where: [{ column: 'deleted_at', op: 'is-null' }],
        orderBy: { column: 'occurred_at', dir: 'desc' },
        limit: 100,
        purpose,
      }),
    ]);

    const interactionRows = interactions.rows ?? [];
    const partyIds = [...new Set(interactionRows.map((i) => i.party_id))];
    const people =
      partyIds.length > 0
        ? await Promise.all([
            ctx.vault.read({
              entity: 'core.party',
              where: [{ column: 'party_id', op: 'in', value: partyIds }],
              purpose,
            }),
            ctx.vault.read({
              entity: 'people.profile',
              where: [{ column: 'party_id', op: 'in', value: partyIds }],
              purpose,
            }),
          ])
        : [{ rows: [] }, { rows: [] }];
    const nameById = new Map((people[0].rows ?? []).map((p) => [p.party_id, p.display_name]));
    const colorById = new Map((people[1].rows ?? []).map((p) => [p.party_id, p.avatar_color]));

    const owner = (entries.rows ?? []).map((e) => ({
      kind: 'entry',
      id: e.entry_id,
      sort_at: e.created_at,
      date: e.entry_date,
      mood: e.mood,
      text: e.body_text,
    }));
    const auto = interactionRows.map((i) => ({
      kind: 'auto',
      id: i.interaction_id,
      sort_at: i.occurred_at,
      date: i.occurred_at,
      touch: i.kind,
      text: i.body_text ?? '',
      party_id: i.party_id,
      name: nameById.get(i.party_id) ?? '—',
      avatar_color: colorById.get(i.party_id) ?? null,
    }));

    const items = [...owner, ...auto].toSorted((a, b) =>
      String(b.sort_at).localeCompare(String(a.sort_at)),
    );
    return { entries: items };
  } catch (err) {
    return { entries: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
