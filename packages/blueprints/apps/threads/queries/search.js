/**
 * Inbox search as a vault projection: the FTS5 index inside the vault does
 * the matching — decoded message bodies and thread subjects — so the app
 * never pulls the whole social.message table to grep it; vault data has no
 * upper bound. The two ranked searches are unioned by thread and only the
 * matched threads are joined back into the exact row shape the inbox query
 * returns, so the UI renders either list with the same code. Where a message
 * body matched, that message's vault snippet (⟦…⟧ hit markers included)
 * rides as the row's snippet; a subject-only match falls back to the
 * thread's usual latest-message snippet.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

// Cap on threads, not raw hits — one busy thread can match many times over.
const THREAD_LIMIT = 50;

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { threads: [] };
  try {
    // Bodies and subjects live in separate FTS tables; search both, best
    // match first. Message hits lead the union — their snippets carry the
    // actual hit — with subject-only threads appended after.
    const [messageHits, threadHits] = await Promise.all([
      ctx.vault.search({ entity: 'social.message', query: term, limit: 100, purpose }),
      ctx.vault.search({ entity: 'social.thread', query: term, limit: THREAD_LIMIT, purpose }),
    ]);
    // First (= best-ranked) matched message per thread keeps its _snippet.
    const matchSnippetByThread = new Map();
    const orderedIds = [];
    for (const m of messageHits.rows ?? []) {
      if (matchSnippetByThread.has(m.thread_id)) continue;
      matchSnippetByThread.set(m.thread_id, typeof m._snippet === 'string' ? m._snippet : '');
      orderedIds.push(m.thread_id);
    }
    for (const t of threadHits.rows ?? []) {
      if (matchSnippetByThread.has(t.thread_id)) continue;
      matchSnippetByThread.set(t.thread_id, ''); // subject-only match — snippet falls back
      orderedIds.push(t.thread_id);
    }
    const threadIds = orderedIds.slice(0, THREAD_LIMIT);
    if (threadIds.length === 0) return { threads: [] };

    // Join the matched threads only — every fetch below is `in`-bounded by
    // the hit list, mirroring the inbox projection's joins row-for-row.
    const inThreads = [{ column: 'thread_id', op: 'in', value: threadIds }];
    const [threads, participants, messages, vaultRow] = await Promise.all([
      ctx.vault.read({ entity: 'social.thread', where: inThreads, purpose }),
      ctx.vault.read({ entity: 'social.thread_participant', where: inThreads, purpose }),
      ctx.vault.read({ entity: 'social.message', where: inThreads, purpose }),
      // core.vault names the owner party — "the other person" in a thread
      // is a fact read from the vault, never a guess.
      ctx.vault.read({ entity: 'core.vault', purpose }),
    ]);
    const partyIds = [...new Set((participants.rows ?? []).map((p) => p.party_id).filter(Boolean))];
    const parties =
      partyIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.party',
            where: [{ column: 'party_id', op: 'in', value: partyIds }],
            purpose,
          })
        : { rows: [] };
    const ownerPartyId = vaultRow.rows?.[0]?.owner_party_id ?? null;
    const nameByParty = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const namesByThread = new Map();
    const othersByThread = new Map();
    // The owner's read cursor per thread — same semantics as the inbox:
    // absence just means "never read".
    const readCursorByThread = new Map();
    for (const tp of participants.rows ?? []) {
      if (!namesByThread.has(tp.thread_id)) namesByThread.set(tp.thread_id, []);
      const name = nameByParty.get(tp.party_id) ?? tp.handle ?? 'Unknown';
      namesByThread.get(tp.thread_id).push(name);
      if (tp.party_id !== ownerPartyId) {
        if (!othersByThread.has(tp.thread_id)) othersByThread.set(tp.thread_id, []);
        othersByThread.get(tp.thread_id).push(name);
      } else if (tp.last_read_at) {
        readCursorByThread.set(tp.thread_id, String(tp.last_read_at));
      }
    }
    // Latest message / draft flag / newest inbound instant per matched
    // thread — the same facts the inbox derives, so unread and draft badges
    // stay truthful inside search results.
    const lastByThread = new Map();
    const draftThreads = new Set();
    const lastInboundByThread = new Map();
    for (const m of messages.rows ?? []) {
      if (m.delivery === 'draft') draftThreads.add(m.thread_id);
      const prev = lastByThread.get(m.thread_id);
      if (!prev || String(m.sent_at ?? '').localeCompare(String(prev.sent_at ?? '')) > 0) {
        lastByThread.set(m.thread_id, m);
      }
      if (ownerPartyId !== null && m.sender_party_id !== ownerPartyId && m.delivery !== 'draft') {
        const when = String(m.sent_at ?? '');
        const prevIn = lastInboundByThread.get(m.thread_id);
        if (!prevIn || when.localeCompare(prevIn) > 0) {
          lastInboundByThread.set(m.thread_id, when);
        }
      }
    }
    // Bodies are fetched only where no message hit supplied a snippet —
    // subject-only matches fall back to the latest message's text.
    const contentIds = [
      ...new Set(
        threadIds
          .filter((id) => !matchSnippetByThread.get(id))
          .map((id) => lastByThread.get(id)?.body_content_id)
          .filter(Boolean),
      ),
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
    const threadById = new Map((threads.rows ?? []).map((t) => [t.thread_id, t]));
    // Union order is rank order (best match first) — keep it.
    const rows = threadIds
      .map((id) => threadById.get(id))
      .filter(Boolean)
      .map((t) => {
        const last = lastByThread.get(t.thread_id);
        const lastInboundAt = lastInboundByThread.get(t.thread_id) ?? null;
        const lastReadAt = readCursorByThread.get(t.thread_id) ?? null;
        return {
          ...t,
          participants: namesByThread.get(t.thread_id) ?? [],
          others: othersByThread.get(t.thread_id) ?? [],
          snippet:
            matchSnippetByThread.get(t.thread_id) ||
            (last ? snippetOf(contentById.get(last.body_content_id)) : ''),
          has_draft: draftThreads.has(t.thread_id),
          last_read_at: lastReadAt,
          last_inbound_at: lastInboundAt,
          unread:
            lastInboundAt !== null &&
            (lastReadAt === null || lastInboundAt.localeCompare(lastReadAt) > 0),
        };
      });
    return { threads: rows };
  } catch (err) {
    return { threads: [], vaultDenied: { code: err.code, message: err.message } };
  }
};

/**
 * Decode a content item's body into a one-line snippet. Inline `data:` URIs
 * carry the payload after the first comma — percent-encoded by default,
 * base64 when the metadata says so (same convention as queries/inbox.js).
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
