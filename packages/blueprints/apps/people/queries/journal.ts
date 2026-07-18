/**
 * The journal, newest first: the owner-level entries you write (a mood and a
 * line about the day) folded together with the interactions you have logged as
 * automatic entries — the way Monica turns a logged call into a journal line.
 * Owner entries carry their chosen mood; auto entries carry the person they
 * were with so the view can render their monogram.
 *
 * TS conversion note: the vault read surface returns `Record<string, unknown>`
 * rows (see HandlerCtx.vault), so each raw row set is cast once to a typed
 * shape (`as unknown as X[]`) at its read site. Handler logic is otherwise
 * byte-for-byte the pre-conversion JS.
 */

interface RawEntry {
  entry_id: string;
  created_at: string;
  entry_date: string;
  mood: string;
  body_text: string;
}

interface RawInteraction {
  interaction_id: string;
  party_id: string;
  occurred_at: string;
  kind: string;
  body_text?: string | null;
}

interface RawParty {
  party_id: string;
  display_name: string;
}

interface RawProfileColor {
  party_id: string;
  avatar_color?: string | null;
}

export default async ({ ctx }: HandlerArgs) => {
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

    const interactionRows = (interactions.rows ?? []) as unknown as RawInteraction[];
    const partyIds = [...new Set<string>(interactionRows.map((i) => i.party_id))];
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
    const partyRows = (people[0].rows ?? []) as unknown as RawParty[];
    const profileRows = (people[1].rows ?? []) as unknown as RawProfileColor[];
    const nameById = new Map<string, string>(
      partyRows.map((p) => [p.party_id, p.display_name] as const),
    );
    const colorById = new Map<string, string | null | undefined>(
      profileRows.map((p) => [p.party_id, p.avatar_color] as const),
    );

    const owner = ((entries.rows ?? []) as unknown as RawEntry[]).map((e) => ({
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
    const e = err as { code?: string; message?: string };
    return { entries: [], vaultDenied: { code: e.code, message: e.message } };
  }
};
