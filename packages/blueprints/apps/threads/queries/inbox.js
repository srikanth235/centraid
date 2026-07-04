/**
 * The inbox projection as a bounded recent window: the newest threads by
 * last_message_at (caller-sized, default 100) — never the whole social table
 * set, because vault data has no upper bound (issue #262). Participants,
 * parties, messages and snippet bodies are joined only for the windowed
 * threads; anything older is reachable through the FTS search query or by
 * growing the window (`truncated` tells the UI to offer that). Each row
 * carries its participants' display names, a last-message snippet, a
 * has_draft flag so the inbox can surface unreleased drafts the way a mail
 * client does, and an unread flag — the owner's read cursor (last_read_at on
 * their participant row) held against the newest inbound message. Messages
 * come from one bulk read (newest 1000 across the window); the rare quiet
 * thread whose history all predates that cap gets a per-thread top-up read,
 * so every visible thread derives its snippet, draft and unread facts.
 * Everything comes from the vault — this app holds no rows of its own. A
 * capped recent
 * slice of the party directory (minus the owner) rides along so the "New
 * message" picker needs no extra scope.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const window = Math.min(Math.max(Number(input?.limit) || 100, 20), 2000);
  try {
    // SQLite puts NULLs last under ORDER BY … DESC, so threads that never
    // saw a message trail the window instead of poisoning its top.
    const [threads, vaultRow, directory] = await Promise.all([
      ctx.vault.read({
        entity: 'social.thread',
        orderBy: { column: 'last_message_at', dir: 'desc' },
        limit: window,
        purpose,
      }),
      // core.vault names the owner party — "the other person" in a thread
      // is a fact read from the vault, never a guess.
      ctx.vault.read({ entity: 'core.vault', purpose }),
      // The New-message picker's directory, deliberately capped: party_id is
      // UUIDv7 (time-ordered), so this is the 500 newest parties — the
      // picker's instant zero-term state. Anyone older is reachable through
      // the find-people search query, and still named correctly as a thread
      // participant here.
      ctx.vault.read({
        entity: 'core.party',
        orderBy: { column: 'party_id', dir: 'desc' },
        limit: 500,
        purpose,
      }),
    ]);
    const ownerPartyId = vaultRow.rows?.[0]?.owner_party_id ?? null;
    const pickerParties = (directory.rows ?? [])
      .filter((p) => p.party_id !== ownerPartyId)
      .map((p) => ({ party_id: p.party_id, display_name: p.display_name }))
      .toSorted((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')));
    const windowedThreads = threads.rows ?? [];
    // `in` over an empty id list is a vault error, so the empty inbox
    // returns before any join.
    if (windowedThreads.length === 0) {
      return { threads: [], parties: pickerParties, truncated: false, window };
    }
    const threadIds = windowedThreads.map((t) => t.thread_id);

    // Joins are `in`-bounded by the window. Messages get their own cap: the
    // newest 1000 across the windowed threads is enough to derive snippet,
    // draft and unread for essentially every visible thread — the few it
    // misses get a per-thread top-up read below.
    const [participants, messages] = await Promise.all([
      ctx.vault.read({
        entity: 'social.thread_participant',
        where: [{ column: 'thread_id', op: 'in', value: threadIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'social.message',
        where: [{ column: 'thread_id', op: 'in', value: threadIds }],
        orderBy: { column: 'sent_at', dir: 'desc' },
        limit: 1000,
        purpose,
      }),
    ]);

    // Participants are named from their own party rows, `in`-bounded — the
    // picker's 500-party cap must never rename someone in a thread.
    const participantPartyIds = [
      ...new Set((participants.rows ?? []).map((tp) => tp.party_id).filter(Boolean)),
    ];
    const participantParties =
      participantPartyIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.party',
            where: [{ column: 'party_id', op: 'in', value: participantPartyIds }],
            purpose,
          })
        : { rows: [] };
    const nameByParty = new Map(
      (participantParties.rows ?? []).map((p) => [p.party_id, p.display_name]),
    );
    const namesByThread = new Map();
    const othersByThread = new Map();
    // The owner's read cursor per thread — social.mark_thread_read stamps
    // last_read_at on the owner's participant row (inserting a silent row
    // when the owner never spoke, so absence here just means "never read").
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
    // Latest message per thread (drafts included — an unreleased draft is
    // exactly what the inbox should surface) + a per-thread draft flag +
    // the newest *inbound* instant. Only a non-owner sender counts as
    // inbound — the owner's own sends (and drafts) never make a thread
    // unread. An unresolved sender (party_id NULL, handle only) is by
    // definition not the owner, so it counts.
    const lastByThread = new Map();
    const draftThreads = new Set();
    const lastInboundByThread = new Map();
    const fold = (m) => {
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
    };
    for (const m of messages.rows ?? []) fold(m);
    // A quiet thread whose entire history fell outside the 1000-message bulk
    // read gets a per-thread top-up: its newest 30 messages — plenty to
    // derive snippet, draft flag and unread — folded through the same
    // derivation. The missed set is empty unless the bulk read actually hit
    // its cap, so the common case costs nothing.
    const missed = windowedThreads.filter(
      (t) => t.last_message_at && !lastByThread.has(t.thread_id),
    );
    if (missed.length > 0) {
      const topUps = await Promise.all(
        missed.map((t) =>
          ctx.vault.read({
            entity: 'social.message',
            where: [{ column: 'thread_id', op: 'eq', value: t.thread_id }],
            orderBy: { column: 'sent_at', dir: 'desc' },
            limit: 30,
            purpose,
          }),
        ),
      );
      for (const chunk of topUps) {
        for (const m of chunk.rows ?? []) fold(m);
      }
    }
    // One content fetch, restricted to the last-message bodies only — after
    // the top-up, so quiet threads' snippets are fetched too.
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
    const rows = windowedThreads
      .map((t) => {
        const last = lastByThread.get(t.thread_id);
        // Unread is a comparison of two vault facts: the newest inbound
        // instant vs the owner's read cursor. No cursor at all with any
        // inbound message = unread (the owner has never opened the thread).
        const lastInboundAt = lastInboundByThread.get(t.thread_id) ?? null;
        const lastReadAt = readCursorByThread.get(t.thread_id) ?? null;
        return {
          ...t,
          participants: namesByThread.get(t.thread_id) ?? [],
          others: othersByThread.get(t.thread_id) ?? [],
          snippet: last ? snippetOf(contentById.get(last.body_content_id)) : '',
          has_draft: draftThreads.has(t.thread_id),
          last_read_at: lastReadAt,
          last_inbound_at: lastInboundAt,
          unread:
            lastInboundAt !== null &&
            (lastReadAt === null || lastInboundAt.localeCompare(lastReadAt) > 0),
        };
      })
      .toSorted((a, b) =>
        String(b.last_message_at ?? b.created_at ?? '').localeCompare(
          String(a.last_message_at ?? a.created_at ?? ''),
        ),
      );
    // A full window means there may be older threads beyond it — the UI
    // offers "Show more" (a re-read with a larger window) and search.
    const truncated = windowedThreads.length >= window;
    return { threads: rows, parties: pickerParties, truncated, window };
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
