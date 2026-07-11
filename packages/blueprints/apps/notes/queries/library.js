/**
 * The notes projection as a bounded recent window: the newest notes by
 * updated_at (caller-sized, default 200) plus every pinned note — never the
 * whole knowledge.note table, because vault data has no upper bound (issue
 * #262). Placements, attachments and canonical bodies are joined only for
 * the windowed rows; anything older is reachable through the FTS search
 * query or by growing the window (`truncated` tells the UI to offer that).
 * Writes go through the knowledge domain's typed commands via this app's
 * actions.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

/**
 * Decode a note body from a content item's content_uri. Canonical bodies
 * live inline as data: URIs; anything else is opaque to this projection.
 *
 * @param {string | undefined} uri
 * @returns {string}
 */
function decodeBody(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('data:')) return '(external content)';
  const comma = uri.indexOf(',');
  if (comma === -1) return '(external content)';
  const meta = uri.slice(0, comma);
  const payload = uri.slice(comma + 1);
  try {
    if (meta.includes(';base64')) {
      return typeof Buffer !== 'undefined'
        ? Buffer.from(payload, 'base64').toString('utf8')
        : atob(payload);
    }
    return decodeURIComponent(payload);
  } catch {
    return '(external content)';
  }
}

/**
 * Group the owner's attachments for one subject type into a map keyed by
 * subject_id, each value a UI-ready list joined to its content item. This is
 * the shared attachment-projection shape every app copies — polymorphic edges
 * in core.attachment, bytes in core.content_item.
 */
function attachmentsBySubject(subjectType, attachments, contentById) {
  // Blob-backed bytes serve as same-origin URLs (issue #296).
  const srcOf = (c) =>
    typeof c?.content_uri === 'string' && c.content_uri.startsWith('blob:')
      ? `/centraid/_vault/blobs/${c.content_id}`
      : c?.content_uri;
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
      content_uri: srcOf(content) ?? '',
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
  const window = Math.min(Math.max(Number(input?.limit) || 200, 20), 2000);
  try {
    // Pinned notes ride beside the window, not inside it — a pin is the
    // owner saying "always on top", which must survive the note aging out
    // of the recent slice.
    const [recent, pinnedNotes, notebooks] = await Promise.all([
      ctx.vault.read({
        entity: 'knowledge.note',
        // Trashed notes (issue #308: delete is reversible) stay out of the library.
        where: [{ column: 'deleted_at', op: 'is-null' }],
        orderBy: { column: 'updated_at', dir: 'desc' },
        limit: window,
        purpose,
      }),
      ctx.vault.read({
        entity: 'knowledge.note',
        where: [
          { column: 'pinned', op: 'eq', value: 1 },
          { column: 'deleted_at', op: 'is-null' },
        ],
        orderBy: { column: 'updated_at', dir: 'desc' },
        limit: 200,
        purpose,
      }),
      // Notebooks are collections (issue #274) — the one curation mechanism.
      ctx.vault.read({ entity: 'core.collection', purpose }),
    ]);
    const byId = new Map();
    for (const n of [...(recent.rows ?? []), ...(pinnedNotes.rows ?? [])]) {
      byId.set(n.note_id, n);
    }
    // Keep the app's notebook row shape over collection rows: a collection
    // may also hold photos and documents; this surface renders its notes.
    const books = (notebooks.rows ?? [])
      .map((c) => ({ notebook_id: c.collection_id, name: c.name, sort_order: c.sort_order }))
      .toSorted((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    const windowed = [...byId.values()];
    if (windowed.length === 0) {
      return { notes: [], notebooks: books, tags: [], truncated: false, window };
    }
    const noteIds = windowed.map((n) => n.note_id);

    // Joins are `in`-bounded by the window — placements, attachment edges,
    // live outbound links (issue #272), then one content pull covering both
    // bodies and attachment bytes.
    const [placements, attachments, links, tags] = await Promise.all([
      ctx.vault.read({
        entity: 'core.collection_entry',
        where: [
          { column: 'target_type', op: 'eq', value: 'knowledge.note' },
          { column: 'target_id', op: 'in', value: noteIds },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [
          { column: 'subject_type', op: 'eq', value: 'knowledge.note' },
          { column: 'subject_id', op: 'in', value: noteIds },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.link',
        where: [
          { column: 'from_type', op: 'eq', value: 'knowledge.note' },
          { column: 'from_id', op: 'in', value: noteIds },
          { column: 'valid_to', op: 'is-null' },
        ],
        purpose,
      }),
      ctx.vault.read({
        entity: 'core.tag',
        where: [
          { column: 'target_type', op: 'eq', value: 'knowledge.note' },
          { column: 'target_id', op: 'in', value: noteIds },
        ],
        purpose,
      }),
    ]);
    const tagRows = tags.rows ?? [];
    const conceptIds = [...new Set(tagRows.map((t) => t.concept_id))];
    const concepts =
      conceptIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.concept',
            where: [{ column: 'concept_id', op: 'in', value: conceptIds }],
            purpose,
          })
        : { rows: [] };
    const labelByConcept = new Map((concepts.rows ?? []).map((c) => [c.concept_id, c.pref_label]));
    const tagsByNote = new Map();
    for (const t of tagRows) {
      if (!tagsByNote.has(t.target_id)) tagsByNote.set(t.target_id, []);
      tagsByNote
        .get(t.target_id)
        .push({ tag_id: t.tag_id, concept_id: t.concept_id, label: labelByConcept.get(t.concept_id) ?? '?' });
    }
    const allTags = [...new Map((concepts.rows ?? []).map((c) => [c.concept_id, c.pref_label])).entries()]
      .map(([concept_id, label]) => ({ concept_id, label }))
      .toSorted((a, b) => a.label.localeCompare(b.label));

    // Cross-domain reference cards: the resolver renders what the owner
    // linked in (resolvable-if-linked) — this app holds no media/finance/…
    // read scopes, and needs none to show the far end of its own links.
    const linkRows = links.rows ?? [];
    const uniqueRefs = [
      ...new Map(
        linkRows.map((l) => [`${l.to_type}/${l.to_id}`, { type: l.to_type, id: l.to_id }]),
      ).values(),
    ];
    // Standoff anchors (issue #282): the inline locator a link may carry.
    // Resolution to text spans is presentation — the app/kit does it; this
    // projection only ships each live link's selector alongside its card.
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
    const referencesByNote = new Map();
    for (const l of linkRows) {
      if (!referencesByNote.has(l.from_id)) referencesByNote.set(l.from_id, []);
      referencesByNote.get(l.from_id).push({
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
    const contentIds = [
      ...new Set([
        ...windowed.map((n) => n.body_content_id),
        ...(attachments.rows ?? []).map((a) => a.content_id),
      ]),
    ].filter(Boolean);
    const contents =
      contentIds.length > 0
        ? await ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] };

    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByNote = attachmentsBySubject('knowledge.note', attachments.rows ?? [], contentById);
    const nameByNotebook = new Map(books.map((nb) => [nb.notebook_id, nb.name]));
    const notebooksByNote = new Map();
    for (const p of placements.rows ?? []) {
      if (!notebooksByNote.has(p.target_id)) notebooksByNote.set(p.target_id, []);
      notebooksByNote.get(p.target_id).push(p.collection_id);
    }
    const rows = windowed
      .map((n) => {
        const notebookIds = notebooksByNote.get(n.note_id) ?? [];
        return {
          note_id: n.note_id,
          title: n.title,
          format: n.format,
          pinned: n.pinned,
          created_at: n.created_at,
          updated_at: n.updated_at,
          body: decodeBody(contentById.get(n.body_content_id)?.content_uri),
          notebook_ids: notebookIds,
          notebook_names: notebookIds.map((id) => nameByNotebook.get(id) ?? 'Notebook'),
          attachments: attByNote.get(n.note_id) ?? [],
          references: referencesByNote.get(n.note_id) ?? [],
          tags: tagsByNote.get(n.note_id) ?? [],
        };
      })
      .toSorted(
        (a, b) =>
          (b.pinned ?? 0) - (a.pinned ?? 0) ||
          String(b.updated_at).localeCompare(String(a.updated_at)),
      );

    // A full window means there may be older notes beyond it — the UI
    // offers "Show more" (a re-read with a larger window) and search.
    const truncated = (recent.rows ?? []).length >= window;
    return { notes: rows, notebooks: books, tags: allTags, truncated, window };
  } catch (err) {
    return { notes: [], notebooks: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
