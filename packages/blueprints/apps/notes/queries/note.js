/**
 * A single note's canonical body, decoded — the editor's on-open pull. The
 * library/search projections ship only a short preview + the checklist tally
 * (issue #404: shipping every note's full body on every doorbell was the
 * cost), so the full text is fetched lazily here when a note is opened.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders it
 * as the "ask the owner for access" state, receipt id included.
 *
 * @type {import('@centraid/app-engine').QueryHandler}
 */

/** Decode a note body from a content item's content_uri (see library.js). */
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
  const noteId = String(input?.note_id ?? '').trim();
  if (!noteId) return { note_id: noteId, body: '' };
  try {
    const notes = await ctx.vault.read({
      entity: 'knowledge.note',
      where: [{ column: 'note_id', op: 'eq', value: noteId }],
      limit: 1,
      purpose,
    });
    const note = (notes.rows ?? [])[0];
    if (!note) return { note_id: noteId, body: '', format: null };
    const contents = note.body_content_id
      ? await ctx.vault.read({
          entity: 'core.content_item',
          where: [{ column: 'content_id', op: 'eq', value: note.body_content_id }],
          limit: 1,
          purpose,
        })
      : { rows: [] };
    const body = decodeBody((contents.rows ?? [])[0]?.content_uri);
    return { note_id: noteId, body, format: note.format };
  } catch (err) {
    return { note_id: noteId, vaultDenied: { code: err.code, message: err.message } };
  }
};
