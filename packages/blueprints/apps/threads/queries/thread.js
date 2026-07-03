/**
 * One thread's messages in sent order. A message row carries no body of its
 * own — `body_content_id` points at a core.content_item, and drafts store
 * their bytes as a `data:` URI in `content_uri` ("rent the bytes, own the
 * reference"). We decode that here; anything not inlined falls back to the
 * content item's title or a placeholder.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/**
 * Group the owner's attachments for one subject type into a map keyed by
 * subject_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(subjectType, attachments, contentById) {
  const bySubject = new Map();
  for (const a of attachments) {
    if (a.subject_type !== subjectType) continue;
    const content = contentById.get(a.content_id);
    if (!bySubject.has(a.subject_id)) bySubject.set(a.subject_id, []);
    bySubject.get(a.subject_id).push({
      attachment_id: a.attachment_id,
      content_id: a.content_id,
      role: a.role,
      is_primary: a.is_primary,
      media_type: content?.media_type ?? 'application/octet-stream',
      title: content?.title ?? null,
      content_uri: content?.content_uri ?? '',
      byte_size: content?.byte_size ?? 0,
    });
  }
  for (const list of bySubject.values()) {
    list.sort((x, y) => (y.is_primary ?? 0) - (x.is_primary ?? 0));
  }
  return bySubject;
}

export default async ({ query, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const threadId = String(query?.thread_id ?? '');
  try {
    const [messages, parties, vaultRow, threadAttachments] = await Promise.all([
      ctx.vault.read({
        entity: 'social.message',
        where: [{ column: 'thread_id', op: 'eq', value: threadId }],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.party', purpose }),
      // core.vault names the owner party — "mine" is a fact read from the
      // vault, never a guess this projection invents.
      ctx.vault.read({ entity: 'core.vault', purpose }),
      // Files shared into the conversation hang off the thread itself, not any
      // one message — polymorphic edges in core.attachment.
      ctx.vault.read({
        entity: 'core.attachment',
        where: [
          { column: 'subject_type', op: 'eq', value: 'social.thread' },
          { column: 'subject_id', op: 'eq', value: threadId },
        ],
        purpose,
      }),
    ]);
    const ownerPartyId = vaultRow.rows?.[0]?.owner_party_id ?? null;
    const rows = (messages.rows ?? []).toSorted((a, b) =>
      String(a.sent_at).localeCompare(String(b.sent_at)),
    );
    const attachmentRows = threadAttachments.rows ?? [];
    // One content-item fetch covers both message bodies and thread attachments.
    const contentIds = [
      ...new Set(
        [
          ...rows.map((m) => m.body_content_id),
          ...attachmentRows.map((a) => a.content_id),
        ].filter(Boolean),
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
    const attByThread = attachmentsBySubject('social.thread', attachmentRows, contentById);
    const nameByParty = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    return {
      messages: rows.map((m) => ({
        message_id: m.message_id,
        thread_id: m.thread_id,
        sender_party_id: m.sender_party_id,
        sender: nameByParty.get(m.sender_party_id) ?? m.sender_handle ?? 'Unknown',
        sent_at: m.sent_at,
        delivery: m.delivery,
        mine: ownerPartyId !== null && m.sender_party_id === ownerPartyId,
        body: bodyOf(contentById.get(m.body_content_id)),
      })),
      attachments: attByThread.get(threadId) ?? [],
    };
  } catch (err) {
    return { messages: [], attachments: [], vaultDenied: { code: err.code, message: err.message } };
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
