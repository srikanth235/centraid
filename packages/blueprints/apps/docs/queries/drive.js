/**
 * The drive as a bounded recent window: folders are SKOS concepts in the
 * owner's folders scheme (uri https://centraid.dev/schemes/folders, whose
 * 'root' concept is the drive's top level), and a document is a
 * core.content_item carrying exactly one folders-scheme tag. Vault data has
 * no upper bound (issue #262), so documents arrive newest-filed-first via
 * their tags (caller-sized, default 200) — never a whole-table content pull;
 * anything older is reachable through the FTS search query or by growing the
 * window (`truncated` tells the UI to offer that). Trashed documents
 * (deleted_at set) keep their tag so a restore lands them back where they
 * were; they ride the same window with trashed=true and their purge date.
 * Starred is a flags-scheme tag on the same canonical content item (issue
 * #274), decorated from one bounded read over the windowed ids — the same
 * star a favorited photo carries. Everything comes from the vault; this
 * app holds no rows of its own.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const FOLDER_SCHEME_URI = 'https://centraid.dev/schemes/folders';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const window = Math.min(Math.max(Number(input?.limit) || 200, 20), 2000);
  try {
    // Structural reads first: concepts and schemes are owner-curated and
    // small, so they stay unbounded — and they bound everything below.
    const [concepts, schemes] = await Promise.all([
      ctx.vault.read({ entity: 'core.concept', purpose }),
      ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
    ]);

    const scheme = (schemes.rows ?? []).find((s) => s.uri === FOLDER_SCHEME_URI);
    const schemeConcepts = (concepts.rows ?? []).filter(
      (c) => scheme && c.scheme_id === scheme.scheme_id,
    );
    const root = schemeConcepts.find((c) => c.notation === 'root');
    const rootFolderId = root?.concept_id ?? null;

    const folders = schemeConcepts
      .filter((c) => c.concept_id !== rootFolderId)
      .map((c) => ({
        folder_id: c.concept_id,
        name: c.pref_label,
        parent_id:
          c.broader_concept_id == null || c.broader_concept_id === rootFolderId
            ? null
            : c.broader_concept_id,
      }))
      .toSorted((a, b) => String(a.name).localeCompare(String(b.name)));

    // A document is a content item tagged with a folders-scheme concept, so
    // the tags ARE the drive's index: one per document, newest filed first.
    // An `in` filter with an empty array throws — no folders scheme yet
    // means an empty drive, not an error.
    const folderConceptIds = schemeConcepts.map((c) => c.concept_id);
    if (folderConceptIds.length === 0) {
      return { folders, documents: [], root_folder_id: rootFolderId, truncated: false, window };
    }
    const tags = await ctx.vault.read({
      entity: 'core.tag',
      where: [
        { column: 'target_type', op: 'eq', value: 'core.content_item' },
        { column: 'concept_id', op: 'in', value: folderConceptIds },
      ],
      orderBy: { column: 'tagged_at', dir: 'desc' },
      limit: window,
      purpose,
    });

    const folderByContent = new Map();
    for (const t of tags.rows ?? []) folderByContent.set(t.target_id, t.concept_id);
    if (folderByContent.size === 0) {
      return { folders, documents: [], root_folder_id: rootFolderId, truncated: false, window };
    }

    // Starred is a flags-scheme tag on the same canonical content item
    // (issue #274) — one bounded read over the windowed ids. No scheme or
    // concept yet just means nothing has ever been starred.
    const flagsScheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConcept = flagsScheme
      ? (concepts.rows ?? []).find(
          (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
        )
      : undefined;

    // The content join is `in`-bounded by the windowed tags — only the
    // documents in the window ever ride the RPC, never every blob in the
    // vault.
    const [contents, starTags] = await Promise.all([
      ctx.vault.read({
        entity: 'core.content_item',
        where: [{ column: 'content_id', op: 'in', value: [...folderByContent.keys()] }],
        purpose,
      }),
      starredConcept
        ? ctx.vault.read({
            entity: 'core.tag',
            where: [
              { column: 'concept_id', op: 'eq', value: starredConcept.concept_id },
              { column: 'target_type', op: 'eq', value: 'core.content_item' },
              { column: 'target_id', op: 'in', value: [...folderByContent.keys()] },
            ],
            purpose,
          })
        : { rows: [] },
    ]);
    const starredIds = new Set((starTags.rows ?? []).map((t) => t.target_id));

    // Blob-backed bytes (issue #296) leave the row as `blob:` addresses —
    // the client gets same-origin serve URLs (Range, immutable caching, and
    // iframe-able PDF previews); inline data: URIs pass through.
    const srcOf = (c) =>
      typeof c.content_uri === 'string' && c.content_uri.startsWith('blob:')
        ? `/centraid/_vault/blobs/${c.content_id}`
        : c.content_uri;

    const documents = (contents.rows ?? [])
      .map((c) => {
        const conceptId = folderByContent.get(c.content_id);
        return {
          content_id: c.content_id,
          title: c.title,
          media_type: c.media_type,
          byte_size: c.byte_size,
          content_uri: srcOf(c),
          created_at: c.created_at,
          folder_id: conceptId === rootFolderId ? null : conceptId,
          starred: starredIds.has(c.content_id),
          trashed: c.deleted_at != null,
          purge_at: c.purge_at ?? null,
        };
      })
      .toSorted((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    // A full window means there may be older documents beyond it — the UI
    // offers "Show more" (a re-read with a larger window) and search.
    const truncated = (tags.rows ?? []).length >= window;
    return { folders, documents, root_folder_id: rootFolderId, truncated, window };
  } catch (err) {
    return {
      folders: [],
      documents: [],
      root_folder_id: null,
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
