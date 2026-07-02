/**
 * The notes projection: every knowledge.note newest first, joined in the
 * handler with its notebook name(s) via knowledge.note_placement and its
 * body decoded from the canonical core.content_item it references. The
 * knowledge domain has no typed commands yet, so this stays read-only —
 * a window over the vault, not a pen.
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

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [notes, notebooks, placements, contents] = await Promise.all([
      ctx.vault.read({ entity: 'knowledge.note', purpose }),
      ctx.vault.read({ entity: 'knowledge.notebook', purpose }),
      ctx.vault.read({ entity: 'knowledge.note_placement', purpose }),
      ctx.vault.read({ entity: 'core.content_item', purpose }),
    ]);

    const nameByNotebook = new Map((notebooks.rows ?? []).map((nb) => [nb.notebook_id, nb.name]));
    const notebooksByNote = new Map();
    for (const p of placements.rows ?? []) {
      if (!notebooksByNote.has(p.note_id)) notebooksByNote.set(p.note_id, []);
      notebooksByNote.get(p.note_id).push(p.notebook_id);
    }
    const uriByContent = new Map((contents.rows ?? []).map((c) => [c.content_id, c.content_uri]));

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
          body: decodeBody(uriByContent.get(n.body_content_id)),
          notebook_ids: notebookIds,
          notebook_names: notebookIds.map((id) => nameByNotebook.get(id) ?? 'Notebook'),
        };
      })
      .toSorted((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));

    const books = (notebooks.rows ?? []).toSorted(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );

    return { notes: rows, notebooks: books };
  } catch (err) {
    return { notes: [], notebooks: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
