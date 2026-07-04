/**
 * Document search as a vault projection: the FTS5 index inside the vault
 * does the matching (title + decoded text body), so the app never pulls the
 * whole core.content_item table to grep it — vault data has no upper bound.
 * Only the matched rows are joined with their folder tags, and a match is a
 * document only if it carries a folders-scheme tag — anything else (a note
 * body, a message attachment, an avatar…) is dropped, so search never
 * surfaces what the drive view wouldn't show. Trashed documents can't match
 * at all: soft-deleted rows fall out of the index. The rows mirror the drive
 * projection's document shape row-for-row, plus the vault's hit snippet.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const FOLDER_SCHEME_URI = 'https://centraid.dev/schemes/folders';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { documents: [] };
  try {
    const matches = await ctx.vault.search({
      entity: 'core.content_item',
      query: term,
      limit: 100,
      purpose,
    });
    const hits = matches.rows ?? [];
    if (hits.length === 0) return { documents: [] };
    const contentIds = hits.map((c) => c.content_id);
    const [tags, concepts, schemes] = await Promise.all([
      ctx.vault.read({
        entity: 'core.tag',
        where: [
          { column: 'target_type', op: 'eq', value: 'core.content_item' },
          { column: 'target_id', op: 'in', value: contentIds },
        ],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
      ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
    ]);

    const scheme = (schemes.rows ?? []).find((s) => s.uri === FOLDER_SCHEME_URI);
    const schemeConcepts = (concepts.rows ?? []).filter(
      (c) => scheme && c.scheme_id === scheme.scheme_id,
    );
    const rootFolderId = schemeConcepts.find((c) => c.notation === 'root')?.concept_id ?? null;

    // A document is a content item tagged with a folders-scheme concept.
    const folderConceptIds = new Set(schemeConcepts.map((c) => c.concept_id));
    const folderByContent = new Map();
    for (const t of tags.rows ?? []) {
      if (folderConceptIds.has(t.concept_id)) folderByContent.set(t.target_id, t.concept_id);
    }

    // Vault order is rank order (best match first) — keep it.
    const documents = hits
      .filter((c) => folderByContent.has(c.content_id))
      .map((c) => {
        const conceptId = folderByContent.get(c.content_id);
        return {
          content_id: c.content_id,
          title: c.title,
          media_type: c.media_type,
          byte_size: c.byte_size,
          content_uri: c.content_uri,
          created_at: c.created_at,
          folder_id: conceptId === rootFolderId ? null : conceptId,
          trashed: c.deleted_at != null,
          purge_at: c.purge_at ?? null,
          snippet: typeof c._snippet === 'string' ? c._snippet : '',
        };
      });
    return { documents };
  } catch (err) {
    return { documents: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
