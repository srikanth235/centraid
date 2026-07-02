/**
 * One thread's messages in sent order. A message row carries no body of its
 * own — `body_content_id` points at a core.content_item, and drafts store
 * their bytes as a `data:` URI in `content_uri` ("rent the bytes, own the
 * reference"). We decode that here; anything not inlined falls back to the
 * content item's title or a placeholder.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */
export default async ({ query, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const threadId = String(query?.thread_id ?? '');
  try {
    const [messages, parties] = await Promise.all([
      ctx.vault.read({
        entity: 'social.message',
        where: [{ column: 'thread_id', op: 'eq', value: threadId }],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.party', purpose }),
    ]);
    const rows = (messages.rows ?? []).toSorted((a, b) =>
      String(a.sent_at).localeCompare(String(b.sent_at)),
    );
    const contentIds = [...new Set(rows.map((m) => m.body_content_id).filter(Boolean))];
    const contentById = new Map();
    if (contentIds.length > 0) {
      const items = await ctx.vault.read({
        entity: 'core.content_item',
        where: [{ column: 'content_id', op: 'in', value: contentIds }],
        purpose,
      });
      for (const item of items.rows ?? []) contentById.set(item.content_id, item);
    }
    const nameByParty = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    return {
      messages: rows.map((m) => ({
        message_id: m.message_id,
        thread_id: m.thread_id,
        sender_party_id: m.sender_party_id,
        sender: nameByParty.get(m.sender_party_id) ?? m.sender_handle ?? 'Unknown',
        sent_at: m.sent_at,
        delivery: m.delivery,
        body: bodyOf(contentById.get(m.body_content_id)),
      })),
    };
  } catch (err) {
    return { messages: [], vaultDenied: { code: err.code, message: err.message } };
  }
};

/**
 * Decode a content item's body. Inline `data:` URIs carry the payload after
 * the first comma — percent-encoded by default, base64 when the metadata
 * says so. Anything else is external custody: fall back to the title.
 *
 * @param {{ content_uri?: string, title?: string } | undefined} item
 * @returns {string}
 */
function bodyOf(item) {
  if (!item) return '(missing content)';
  const uri = String(item.content_uri ?? '');
  if (uri.startsWith('data:')) {
    const comma = uri.indexOf(',');
    if (comma !== -1) {
      const meta = uri.slice(5, comma);
      const payload = uri.slice(comma + 1);
      try {
        if (meta.split(';').includes('base64')) {
          return Buffer.from(payload, 'base64').toString('utf8');
        }
        return decodeURIComponent(payload);
      } catch {
        return payload;
      }
    }
  }
  return item.title ?? '(external content)';
}
