/**
 * The whole drive in one read: folders are SKOS concepts in the owner's
 * folders scheme (uri https://centraid.dev/schemes/folders, whose 'root'
 * concept is the drive's top level), and a document is a core.content_item
 * carrying exactly one folders-scheme tag. Trashed documents (deleted_at
 * set) keep their tag so a restore lands them back where they were; they
 * come through with trashed=true and their purge date. Everything comes
 * from the vault; this app holds no rows of its own.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

const FOLDER_SCHEME_URI = 'https://centraid.dev/schemes/folders';

export default async ({ ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  try {
    const [contents, tags, concepts, schemes] = await Promise.all([
      ctx.vault.read({ entity: 'core.content_item', purpose }),
      ctx.vault.read({
        entity: 'core.tag',
        where: [{ column: 'target_type', op: 'eq', value: 'core.content_item' }],
        purpose,
      }),
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

    // A document is a content item tagged with a folders-scheme concept.
    const folderConceptIds = new Set(schemeConcepts.map((c) => c.concept_id));
    const folderByContent = new Map();
    for (const t of tags.rows ?? []) {
      if (folderConceptIds.has(t.concept_id)) folderByContent.set(t.target_id, t.concept_id);
    }

    const documents = (contents.rows ?? [])
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
        };
      })
      .toSorted((a, b) => String(b.created_at).localeCompare(String(a.created_at)));

    return { folders, documents, root_folder_id: rootFolderId };
  } catch (err) {
    return {
      folders: [],
      documents: [],
      root_folder_id: null,
      vaultDenied: { code: err.code, message: err.message },
    };
  }
};
