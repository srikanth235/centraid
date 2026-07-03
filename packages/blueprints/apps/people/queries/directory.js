/**
 * The people projection: every party in the vault, sorted by sort name
 * (falling back to display name), joined in the handler with its identifiers
 * (core.party_identifier) and contact card (social.contact_card) if one
 * decorates it. Everything comes from the vault — this app holds no rows of
 * its own.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
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

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [parties, identifiers, cards, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'core.party', purpose }),
      ctx.vault.read({ entity: 'core.party_identifier', purpose }),
      ctx.vault.read({ entity: 'social.contact_card', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'core.party' }],
        purpose,
      }),
    ]);
    const idsByParty = new Map();
    for (const row of identifiers.rows ?? []) {
      if (!idsByParty.has(row.party_id)) idsByParty.set(row.party_id, []);
      idsByParty.get(row.party_id).push(row);
    }
    const cardByParty = new Map();
    for (const card of cards.rows ?? []) cardByParty.set(card.party_id, card);
    // Fetch only the content items the attachments actually reference —
    // the party edges above are the index, so an unscoped content read
    // would drag every byte-blob in the vault through the gateway.
    const attachmentRows = attachments.rows ?? [];
    const contentIds = [...new Set(attachmentRows.map((a) => a.content_id).filter(Boolean))];
    const contentById = new Map();
    if (contentIds.length > 0) {
      const contents = await ctx.vault.read({
        entity: 'core.content_item',
        where: [{ column: 'content_id', op: 'in', value: contentIds }],
        purpose,
      });
      for (const c of contents.rows ?? []) contentById.set(c.content_id, c);
    }
    const attByParty = attachmentsBySubject('core.party', attachmentRows, contentById);
    const sortKey = (p) => String(p.sort_name ?? p.display_name);
    const people = (parties.rows ?? [])
      .toSorted((a, b) => sortKey(a).localeCompare(sortKey(b)))
      .map((party) => ({
        ...party,
        identifiers: idsByParty.get(party.party_id) ?? [],
        card: cardByParty.get(party.party_id) ?? null,
        attachments: attByParty.get(party.party_id) ?? [],
      }));
    return { people };
  } catch (err) {
    return { people: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
