/**
 * Lead search as a vault projection: the FTS5 index inside the vault does
 * the matching, so the app never pulls every contact to grep them. A lead's
 * searchable text lives on two entities — the name on core.party, the org
 * line and running note on social.contact_card — so both indexes are asked
 * and their hits union to one set of parties. A business.client row is what
 * makes a party a lead, so matched parties without one are dropped, and the
 * survivors are joined (identifiers, cards, attachments — each scoped to the
 * matched ids only) into the exact card shape the pipeline query returns.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const MAX_LEADS = 50;

/** Shared attachment-projection shape (see the pipeline query). */
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

export default async ({ input, ctx }) => {
  const purpose = 'dpv:Billing';
  const term = String(input?.term ?? '').trim();
  if (!term) return { leads: [] };
  try {
    const [partyHits, cardHits] = await Promise.all([
      ctx.vault.search({ entity: 'core.party', query: term, limit: 100, purpose }),
      ctx.vault.search({ entity: 'social.contact_card', query: term, limit: 100, purpose }),
    ]);
    // Union in rank order: name matches first, then card-only matches. A
    // party hit by both keeps its best (name) position.
    const hitPartyIds = [];
    const seen = new Set();
    for (const row of [...(partyHits.rows ?? []), ...(cardHits.rows ?? [])]) {
      if (!row.party_id || seen.has(row.party_id)) continue;
      seen.add(row.party_id);
      hitPartyIds.push(row.party_id);
    }
    if (hitPartyIds.length === 0) return { leads: [] };

    const clients = await ctx.vault.read({
      entity: 'business.client',
      where: [{ column: 'party_id', op: 'in', value: hitPartyIds }],
      purpose,
    });
    const rankByParty = new Map(hitPartyIds.map((id, i) => [id, i]));
    const clientRows = (clients.rows ?? [])
      .toSorted((a, b) => (rankByParty.get(a.party_id) ?? 0) - (rankByParty.get(b.party_id) ?? 0))
      .slice(0, MAX_LEADS);
    if (clientRows.length === 0) return { leads: [] };

    const partyIds = [...new Set(clientRows.map((c) => c.party_id))];
    const clientIds = clientRows.map((c) => c.client_id);
    const [parties, cards, identifiers, attachments] = await Promise.all([
      ctx.vault.read({
        entity: 'core.party',
        where: [{ column: 'party_id', op: 'in', value: partyIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'social.contact_card',
        where: [{ column: 'party_id', op: 'in', value: partyIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.party_identifier',
        where: [{ column: 'party_id', op: 'in', value: partyIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [
          { column: 'subject_type', op: 'eq', value: 'business.client' },
          { column: 'subject_id', op: 'in', value: clientIds },
        ],
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

    // Rank order (best match first) survives into the board; the app groups
    // by stage client-side, so within a column this IS relevance order.
    const leads = clientRows.map((c) => ({
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
    }));

    return { leads };
  } catch (err) {
    return { leads: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
