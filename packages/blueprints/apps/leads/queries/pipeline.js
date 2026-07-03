/**
 * The leads pipeline: a projection over business.client, whose lead → active
 * → past lifecycle is the pipeline itself. Each client is joined to its core
 * party for a name and its social.contact_card for a running note; files
 * (a proposal, a brief) attach per lead. Parties not yet enrolled are offered
 * as candidates to add. Everything comes from the vault; this app holds no
 * rows of its own.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/** Shared attachment-projection shape (see the Notes app). */
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
  const purpose = 'dpv:Billing';
  try {
    const [clients, parties, cards, identifiers, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'business.client', purpose }),
      ctx.vault.read({ entity: 'core.party', purpose }),
      ctx.vault.read({ entity: 'social.contact_card', purpose }),
      ctx.vault.read({ entity: 'core.party_identifier', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'business.client' }],
        purpose,
      }),
    ]);

    const partyName = new Map((parties.rows ?? []).map((p) => [p.party_id, p.display_name]));
    const noteByParty = new Map((cards.rows ?? []).map((c) => [c.party_id, c.note]));

    // One best handle per scheme per party — primary first — so a card can
    // offer mailto:/tel: without dragging the whole identifier table along.
    const idsByParty = new Map();
    for (const row of identifiers.rows ?? []) {
      if (!idsByParty.has(row.party_id)) idsByParty.set(row.party_id, []);
      idsByParty.get(row.party_id).push(row);
    }
    const bestHandle = (partyId, scheme) => {
      const ids = idsByParty.get(partyId) ?? [];
      const hit =
        ids.find((i) => i.scheme === scheme && i.is_primary) ??
        ids.find((i) => i.scheme === scheme);
      return hit?.value ?? null;
    };

    // Fetch only the content items the attachments reference — an unscoped
    // content read would drag every byte-blob in the vault through here.
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
    const attByClient = attachmentsBySubject('business.client', attachmentRows, contentById);

    const clientRows = clients.rows ?? [];
    const leads = clientRows
      .map((c) => ({
        client_id: c.client_id,
        party_id: c.party_id,
        name: partyName.get(c.party_id) ?? c.client_id,
        status: c.status, // lead | active | past
        default_rate_minor: c.default_rate_minor,
        currency: c.currency,
        note: noteByParty.get(c.party_id) ?? null,
        email: bestHandle(c.party_id, 'email'),
        tel: bestHandle(c.party_id, 'tel'),
        attachments: attByClient.get(c.client_id) ?? [],
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));

    // Parties not yet enrolled as clients — the add-lead picker.
    const enrolled = new Set(clientRows.map((c) => c.party_id));
    const candidates = (parties.rows ?? [])
      .filter((p) => !enrolled.has(p.party_id))
      .map((p) => ({ party_id: p.party_id, display_name: p.display_name }))
      .toSorted((a, b) => String(a.display_name).localeCompare(String(b.display_name)));

    return { leads, candidates };
  } catch (err) {
    return { leads: [], candidates: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
