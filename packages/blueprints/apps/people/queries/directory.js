/**
 * The people projection as a bounded recent window: the most recently
 * touched parties by updated_at (caller-sized, default 500) — never the
 * whole core.party table, because vault data has no upper bound (issue
 * #262). Identifiers (core.party_identifier), contact cards
 * (social.contact_card) and attachments are joined only for the windowed
 * rows; anyone older is reachable through the FTS search query or by
 * growing the window (`truncated` tells the UI to offer that). Recency
 * bounds the window, but within it the directory keeps its sort-name
 * order — recency selects, the name presents.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

/**
 * The windowed party ids carrying the flags-scheme starred tag (issue
 * #274). Favorite is entity-scoped meaning on the canonical core.party —
 * one bounded tag read, never a card column.
 */
async function starredParties(ctx, partyIds, purpose) {
  if (partyIds.length === 0) return new Set();
  const [schemes, concepts] = await Promise.all([
    ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
    ctx.vault.read({ entity: 'core.concept', purpose }),
  ]);
  const scheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
  const starred = scheme
    ? (concepts.rows ?? []).find(
        (c) => c.scheme_id === scheme.scheme_id && c.notation === 'starred',
      )
    : undefined;
  if (!starred) return new Set();
  const tags = await ctx.vault.read({
    entity: 'core.tag',
    where: [
      { column: 'concept_id', op: 'eq', value: starred.concept_id },
      { column: 'target_type', op: 'eq', value: 'core.party' },
      { column: 'target_id', op: 'in', value: partyIds },
    ],
    purpose,
  });
  return new Set((tags.rows ?? []).map((t) => t.target_id));
}

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

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  try {
    const parties = await ctx.vault.read({
      entity: 'core.party',
      orderBy: { column: 'updated_at', dir: 'desc' },
      limit: window,
      purpose,
    });
    const windowed = parties.rows ?? [];
    if (windowed.length === 0) return { people: [], truncated: false, window };
    const partyIds = windowed.map((p) => p.party_id);

    // Joins are `in`-bounded by the window — identifiers, cards, and the
    // attachment edges for exactly these parties, nothing beyond them.
    const [identifiers, cards, attachments] = await Promise.all([
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
    const starredIds = await starredParties(ctx, partyIds, purpose);
    const sortKey = (p) => String(p.sort_name ?? p.display_name);
    const people = windowed
      .toSorted((a, b) => sortKey(a).localeCompare(sortKey(b)))
      .map((party) => ({
        ...party,
        identifiers: idsByParty.get(party.party_id) ?? [],
        card: cardByParty.get(party.party_id) ?? null,
        favorite: starredIds.has(party.party_id) ? 1 : 0,
        attachments: attByParty.get(party.party_id) ?? [],
      }));

    // A full window means there may be more people beyond it — the UI
    // offers "Show more" (a re-read with a larger window) and search.
    const truncated = windowed.length >= window;
    return { people, truncated, window };
  } catch (err) {
    return { people: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
