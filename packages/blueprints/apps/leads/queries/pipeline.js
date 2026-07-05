/**
 * The leads pipeline as a bounded recent window: the newest clients
 * (caller-sized, default 500 — a kanban rarely shows more), never the whole
 * business.client table, because vault data has no upper bound (issue #262).
 * business.client carries no timestamp, but client_id is UUIDv7, so
 * descending PK order IS newest-first enrolment. Each windowed client is
 * joined to its core party for a name and its social.contact_card for a
 * running note; files (a proposal, a brief) attach per lead. Anything older
 * is reachable through the FTS search query or by growing the window
 * (`truncated` tells the UI to offer that). Parties not yet enrolled are
 * offered as candidates to add. Everything comes from the vault; this app
 * holds no rows of its own.
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

export default async ({ input, ctx }) => {
  const purpose = 'dpv:Billing';
  const window = Math.min(Math.max(Number(input?.limit) || 500, 20), 2000);
  try {
    const [clients, candidateParties] = await Promise.all([
      ctx.vault.read({
        entity: 'business.client',
        orderBy: { column: 'client_id', dir: 'desc' },
        limit: window,
        purpose,
      }),
      // The add-lead picker offers the newest 300 parties (party_id is UUIDv7
      // too) — a deliberate cap: the picker is a convenience shortlist, not a
      // directory, and anyone beyond it is reachable through search or the
      // new-contact flow.
      ctx.vault.read({
        entity: 'core.party',
        orderBy: { column: 'party_id', dir: 'desc' },
        limit: 300,
        purpose,
      }),
    ]);

    const clientRows = clients.rows ?? [];
    // A full window means there may be older leads beyond it — the UI offers
    // "Show more" (a re-read with a larger window) and search.
    const truncated = clientRows.length >= window;

    // Enrolment must be judged exactly, not against the windowed clients — a
    // party whose client row aged out of the window is still a client, and
    // offering them in the picker would collide with business_client's
    // one-client-per-party. One `in`-bounded read over the shortlist settles
    // it without pulling the client table.
    const candidateRows = candidateParties.rows ?? [];
    const enrolled = new Set(clientRows.map((c) => c.party_id));
    if (candidateRows.length > 0) {
      const shortlistClients = await ctx.vault.read({
        entity: 'business.client',
        where: [{ column: 'party_id', op: 'in', value: candidateRows.map((p) => p.party_id) }],
        purpose,
      });
      for (const c of shortlistClients.rows ?? []) enrolled.add(c.party_id);
    }
    const candidates = candidateRows
      .filter((p) => !enrolled.has(p.party_id))
      .map((p) => ({ party_id: p.party_id, display_name: p.display_name }))
      .toSorted((a, b) => String(a.display_name).localeCompare(String(b.display_name)));

    // `in` with an empty array throws — with zero clients there is nothing
    // to join, so return the empty board (the picker still stands).
    if (clientRows.length === 0) {
      return { leads: [], candidates, truncated: false, window };
    }

    const partyIds = [...new Set(clientRows.map((c) => c.party_id).filter(Boolean))];
    const clientIds = clientRows.map((c) => c.client_id);

    // Joins are `in`-bounded by the window — names, running notes, handles
    // and attachment edges only for the clients on the board.
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

    // Cross-references (issues #272 + #282): a lead's running note can @-mention
    // any vault entity. Anchors ride core.party (the stable identity the note's
    // card enriches). Read live outbound links + standoff anchors and resolve
    // the far-end cards (resolvable-if-linked). Same shape as notes/library.js.
    const links =
      partyIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.link',
            where: [
              { column: 'from_type', op: 'eq', value: 'core.party' },
              { column: 'from_id', op: 'in', value: partyIds },
              { column: 'valid_to', op: 'is-null' },
            ],
            purpose,
          })
        : { rows: [] };
    const linkRows = links.rows ?? [];
    const uniqueRefs = [
      ...new Map(
        linkRows.map((l) => [`${l.to_type}/${l.to_id}`, { type: l.to_type, id: l.to_id }]),
      ).values(),
    ];
    const [resolved, anchors] = await Promise.all([
      uniqueRefs.length > 0
        ? ctx.vault.resolve({ refs: uniqueRefs, purpose })
        : Promise.resolve({ cards: [] }),
      linkRows.length > 0
        ? ctx.vault.read({
            entity: 'core.link_anchor',
            where: [{ column: 'link_id', op: 'in', value: linkRows.map((l) => l.link_id) }],
            purpose,
          })
        : Promise.resolve({ rows: [] }),
    ]);
    const cardByRef = new Map((resolved.cards ?? []).map((c) => [`${c.type}/${c.id}`, c]));
    const selectorByLink = new Map();
    for (const a of anchors.rows ?? []) {
      try {
        selectorByLink.set(a.link_id, JSON.parse(a.selector_json));
      } catch {
        // an unreadable selector is just an unanchored reference
      }
    }
    const refsByParty = new Map();
    for (const l of linkRows) {
      if (!refsByParty.has(l.from_id)) refsByParty.set(l.from_id, []);
      refsByParty.get(l.from_id).push({
        link_id: l.link_id,
        selector: selectorByLink.get(l.link_id) ?? null,
        card: cardByRef.get(`${l.to_type}/${l.to_id}`) ?? {
          type: l.to_type,
          id: l.to_id,
          status: 'unknown',
          title: null,
          subtitle: null,
          thumbnail_content_id: null,
        },
      });
    }

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
        references: refsByParty.get(c.party_id) ?? [],
      }))
      .toSorted((a, b) => a.name.localeCompare(b.name));

    return { leads, candidates, truncated, window };
  } catch (err) {
    return { leads: [], candidates: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
