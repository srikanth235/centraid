/**
 * The notes projection: every knowledge.note, pinned first then newest,
 * joined in the handler with its notebook name(s) via
 * knowledge.note_placement and its body decoded from the canonical
 * core.content_item it references. Writes go through the knowledge
 * domain's typed commands via this app's actions.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
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
    const [notes, notebooks, placements, contents, attachments] = await Promise.all([
      ctx.vault.read({ entity: 'knowledge.note', purpose }),
      ctx.vault.read({ entity: 'knowledge.notebook', purpose }),
      ctx.vault.read({ entity: 'knowledge.note_placement', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [{ column: 'subject_type', op: 'eq', value: 'knowledge.note' }],
        purpose,
      }),
    ]);

    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByNote = attachmentsBySubject('knowledge.note', attachments.rows ?? [], contentById);
    const nameByNotebook = new Map((notebooks.rows ?? []).map((nb) => [nb.notebook_id, nb.name]));
    const notebooksByNote = new Map();
    for (const p of placements.rows ?? []) {
      if (!notebooksByNote.has(p.note_id)) notebooksByNote.set(p.note_id, []);
      notebooksByNote.get(p.note_id).push(p.notebook_id);
    }
    const rows = (notes.rows ?? [])
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
        };
      })
      .toSorted(
        (a, b) =>
          (b.pinned ?? 0) - (a.pinned ?? 0) ||
          String(b.updated_at).localeCompare(String(a.updated_at)),
      );

    const books = (notebooks.rows ?? []).toSorted(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );

    return { notes: rows, notebooks: books };
  } catch (err) {
    return { notes: [], notebooks: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
