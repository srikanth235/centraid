/**
 * The inbox projection: every social.thread, most recent activity first,
 * with its participants' display names attached. Everything comes from the
 * vault — this app holds no rows of its own.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [threads, participants, parties] = await Promise.all([
      ctx.vault.read({ entity: 'social.thread', purpose }),
      ctx.vault.read({ entity: 'social.thread_participant', purpose }),
      ctx.vault.read({ entity: 'core.party', purpose }),
    ]);
    const nameByParty = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const namesByThread = new Map();
    for (const tp of participants.rows ?? []) {
      if (!namesByThread.has(tp.thread_id)) namesByThread.set(tp.thread_id, []);
      namesByThread.get(tp.thread_id).push(nameByParty.get(tp.party_id) ?? tp.handle ?? 'Unknown');
    }
    const rows = (threads.rows ?? [])
      .map((t) => ({ ...t, participants: namesByThread.get(t.thread_id) ?? [] }))
      .toSorted((a, b) =>
        String(b.last_message_at ?? b.created_at ?? '').localeCompare(
          String(a.last_message_at ?? a.created_at ?? ''),
        ),
      );
    return { threads: rows };
  } catch (err) {
    return { threads: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
