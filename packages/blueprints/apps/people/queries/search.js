/**
 * People search as a vault projection: the FTS5 index inside the vault does
 * the matching, so the app never pulls every party to grep them. A person's
 * searchable text lives on two entities — the name on core.party, the
 * nickname, org line and running note on social.contact_card — so both
 * indexes are asked and their hits union to one set of parties. The matches
 * are joined (identifiers, cards, attachments — each scoped to the matched
 * ids only) into the exact row shape the directory query returns, plus a
 * `snippet` carrying the vault's ⟦…⟧ hit markers so the UI can show why
 * each person matched.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const MAX_PEOPLE = 50;

/** The shared attachment projection — see directory.js for the shape's home. */
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
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { people: [] };
  try {
    const [partyHits, cardHits] = await Promise.all([
      ctx.vault.search({ entity: 'core.party', query: term, limit: 100, purpose }),
      ctx.vault.search({ entity: 'social.contact_card', query: term, limit: 100, purpose }),
    ]);
    // Union in rank order: name matches first, then card-only matches. A
    // party hit by both keeps its best (name) position — and that snippet.
    const hitPartyIds = [];
    const snippetByParty = new Map();
    for (const row of [...(partyHits.rows ?? []), ...(cardHits.rows ?? [])]) {
      if (!row.party_id || snippetByParty.has(row.party_id)) continue;
      snippetByParty.set(row.party_id, typeof row._snippet === 'string' ? row._snippet : '');
      hitPartyIds.push(row.party_id);
    }
    const partyIds = hitPartyIds.slice(0, MAX_PEOPLE);
    if (partyIds.length === 0) return { people: [] };

    // Joins are `in`-bounded by the matched ids — the same shape the
    // directory window builds, so the UI renders either list with one code.
    const [parties, identifiers, cards, attachments] = await Promise.all([
      ctx.vault.read({
        entity: 'core.party',
        where: [{ column: 'party_id', op: 'in', value: partyIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.party_identifier',
        where: [{ column: 'party_id', op: 'in', value: partyIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'social.contact_card',
        where: [{ column: 'party_id', op: 'in', value: partyIds }],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [
          { column: 'subject_type', op: 'eq', value: 'core.party' },
          { column: 'subject_id', op: 'in', value: partyIds },
        ],
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
    // Fetch only the content items the attachments actually reference — an
    // unscoped content read would drag every byte-blob in the vault through.
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

    // Vault order is rank order (best match first) — keep it, no name sort.
    const partyById = new Map((parties.rows ?? []).map((p) => [p.party_id, p]));
    const people = partyIds
      .map((id) => partyById.get(id))
      .filter(Boolean)
      .map((party) => ({
        ...party,
        identifiers: idsByParty.get(party.party_id) ?? [],
        card: cardByParty.get(party.party_id) ?? null,
        attachments: attByParty.get(party.party_id) ?? [],
        snippet: snippetByParty.get(party.party_id) ?? '',
      }));

    return { people };
  } catch (err) {
    return { people: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
