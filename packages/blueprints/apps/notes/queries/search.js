/**
 * Note search as a vault projection: the FTS5 index inside the vault does
 * the matching (title + canonical body), so the app never pulls the whole
 * knowledge.note table to grep it — vault data has no upper bound. Only the
 * matched rows are joined with their decoded bodies and notebook names,
 * mirroring the library projection's shape row-for-row so the UI renders
 * either list with the same code.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

/** The shared attachment projection — see library.js for the shape's home. */
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

/** @param {string | undefined} uri @returns {string} */
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

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { notes: [] };
  try {
    const matches = await ctx.vault.search({
      entity: 'knowledge.note',
      query: term,
      // Trashed notes (issue #308: delete is reversible) never match.
      where: [{ column: 'deleted_at', op: 'is-null' }],
      limit: 100,
      purpose,
    });
    const hits = matches.rows ?? [];
    if (hits.length === 0) return { notes: [] };
    const noteIds = hits.map((n) => n.note_id);
    const [placements, notebooks, attachments] = await Promise.all([
      ctx.vault.read({
        entity: 'core.collection_entry',
        where: [
          { column: 'target_type', op: 'eq', value: 'knowledge.note' },
          { column: 'target_id', op: 'in', value: noteIds },
        ],
        purpose,
      }),
      // Notebooks are collections (issue #274) — the one curation mechanism.
      ctx.vault.read({ entity: 'core.collection', purpose }),
      ctx.vault.read({
        entity: 'core.attachment',
        where: [
          { column: 'subject_type', op: 'eq', value: 'knowledge.note' },
          { column: 'subject_id', op: 'in', value: noteIds },
        ],
        purpose,
      }),
    ]);
    // One bounded pull covers both the note bodies and any attachment bytes.
    const contentIds = [
      ...new Set([
        ...hits.map((n) => n.body_content_id),
        ...(attachments.rows ?? []).map((a) => a.content_id),
      ]),
    ];
    const contents = await ctx.vault.read({
      entity: 'core.content_item',
      where: [{ column: 'content_id', op: 'in', value: contentIds }],
      purpose,
    });
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));
    const attByNote = attachmentsBySubject('knowledge.note', attachments.rows ?? [], contentById);
    const nameByNotebook = new Map((notebooks.rows ?? []).map((nb) => [nb.collection_id, nb.name]));
    const notebooksByNote = new Map();
    for (const p of placements.rows ?? []) {
      if (!notebooksByNote.has(p.target_id)) notebooksByNote.set(p.target_id, []);
      notebooksByNote.get(p.target_id).push(p.collection_id);
    }
    // Vault order is rank order (best match first) — keep it.
    const notes = hits.map((n) => {
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
        snippet: typeof n._snippet === 'string' ? n._snippet : '',
      };
    });
    return { notes };
  } catch (err) {
    return { notes: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
