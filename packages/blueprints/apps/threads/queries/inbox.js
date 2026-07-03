/**
 * The inbox projection: every social.thread, most recent activity first,
 * with its participants' display names, a last-message snippet, and a
 * has_draft flag so the inbox can surface unreleased drafts the way a mail
 * client does. Everything comes from the vault — this app holds no rows of
 * its own. The full party directory (minus the owner) rides along so the
 * "New message" picker needs no extra scope.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [threads, participants, parties, vaultRow, messages] = await Promise.all([
      ctx.vault.read({ entity: 'social.thread', purpose }),
      ctx.vault.read({ entity: 'social.thread_participant', purpose }),
      ctx.vault.read({ entity: 'core.party', purpose }),
      // core.vault names the owner party — "the other person" in a thread
      // is a fact read from the vault, never a guess.
      ctx.vault.read({ entity: 'core.vault', purpose }),
      ctx.vault.read({ entity: 'social.message', purpose }),
    ]);
    const ownerPartyId = vaultRow.rows?.[0]?.owner_party_id ?? null;
    const nameByParty = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const namesByThread = new Map();
    const othersByThread = new Map();
    for (const tp of participants.rows ?? []) {
      if (!namesByThread.has(tp.thread_id)) namesByThread.set(tp.thread_id, []);
      const name = nameByParty.get(tp.party_id) ?? tp.handle ?? 'Unknown';
      namesByThread.get(tp.thread_id).push(name);
      if (tp.party_id !== ownerPartyId) {
        if (!othersByThread.has(tp.thread_id)) othersByThread.set(tp.thread_id, []);
        othersByThread.get(tp.thread_id).push(name);
      }
    }
    // Latest message per thread (drafts included — an unreleased draft is
    // exactly what the inbox should surface) + a per-thread draft flag.
    const lastByThread = new Map();
    const draftThreads = new Set();
    for (const m of messages.rows ?? []) {
      if (m.delivery === 'draft') draftThreads.add(m.thread_id);
      const prev = lastByThread.get(m.thread_id);
      if (!prev || String(m.sent_at ?? '').localeCompare(String(prev.sent_at ?? '')) > 0) {
        lastByThread.set(m.thread_id, m);
      }
    }
    // One content fetch, restricted to the last-message bodies only.
    const contentIds = [
      ...new Set([...lastByThread.values()].map((m) => m.body_content_id).filter(Boolean)),
    ];
    const contentById = new Map();
    if (contentIds.length > 0) {
      const items = await ctx.vault.read({
        entity: 'core.content_item',
        where: [{ column: 'content_id', op: 'in', value: contentIds }],
        purpose,
      });
      for (const item of items.rows ?? []) contentById.set(item.content_id, item);
    }
    const rows = (threads.rows ?? [])
      .map((t) => {
        const last = lastByThread.get(t.thread_id);
        return {
          ...t,
          participants: namesByThread.get(t.thread_id) ?? [],
          others: othersByThread.get(t.thread_id) ?? [],
          snippet: last ? snippetOf(contentById.get(last.body_content_id)) : '',
          has_draft: draftThreads.has(t.thread_id),
        };
      })
      .toSorted((a, b) =>
        String(b.last_message_at ?? b.created_at ?? '').localeCompare(
          String(a.last_message_at ?? a.created_at ?? ''),
        ),
      );
    return {
      threads: rows,
      parties: (parties.rows ?? [])
        .filter((p) => p.party_id !== ownerPartyId)
        .map((p) => ({ party_id: p.party_id, display_name: p.display_name }))
        .toSorted((a, b) =>
          String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')),
        ),
    };
  } catch (err) {
    return { threads: [], parties: [], vaultDenied: { code: err.code, message: err.message } };
  }
};

/**
 * Decode a content item's body into a one-line snippet. Inline `data:` URIs
 * carry the payload after the first comma — percent-encoded by default,
 * base64 when the metadata says so (same convention as queries/thread.js).
 *
 * @param {{ content_uri?: string, title?: string } | undefined} item
 * @returns {string}
 */
function snippetOf(item) {
  if (!item) return '';
  const uri = String(item.content_uri ?? '');
  let text = item.title ?? '';
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma !== -1) {
      const meta = uri.slice(5, comma);
      const payload = uri.slice(comma + 1);
      try {
        text = meta.split(';').includes('base64')
          ? Buffer.from(payload, 'base64').toString('utf8')
          : decodeURIComponent(payload);
      } catch {
        text = payload;
      }
    }
  }
  return String(text).replace(/\s+/g, ' ').trim().slice(0, 140);
}
