/**
 * Document search as a vault projection: the FTS5 index inside the vault
 * matches against `core.document` (title + the current version's decoded
 * text body, issue #352 — documents are searched under their own identity,
 * not the raw content item), so the app never pulls the whole table to grep
 * it — vault data has no upper bound. Only the matched rows are joined with
 * their folder tags, and a match is a document only if it carries a
 * folders-scheme tag — anything else is dropped, so search never surfaces
 * what the drive view wouldn't show. Trashed documents can't match at all:
 * soft-deleted rows fall out of the index. The rows mirror the drive
 * projection's document shape row-for-row, plus the vault's hit snippet.
 *
 * A consent denial is a first-class outcome, not an error: the UI renders
 * it as the "ask the owner for access" state.
 *
 * Phase 4 (issue #352) decorates matches with the same `tags`/`custody_state`
 * joins drive.js makes (factored into ./_shared.js) — so a tag filter or a
 * custody badge reads identically whether the row arrived via browse or
 * search.
 *
 * @type {import('@centraid/openclaw-plugin').QueryHandler}
 */

import { readCustodyByContent, readLabelsByDocument } from './_shared.js';

const FOLDER_SCHEME_URI = 'https://centraid.dev/schemes/folders';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';
const DOCUMENT_TARGET_TYPE = 'core.document';

export default async ({ input, ctx }) => {
  const purpose = 'dpv:ServiceProvision';
  const term = String(input?.term ?? '').trim();
  if (!term) return { documents: [] };
  try {
    const matches = await ctx.vault.search({
      entity: 'core.document',
      query: term,
      limit: 100,
      purpose,
    });
    const hits = matches.rows ?? [];
    if (hits.length === 0) return { documents: [] };
    const documentIds = hits.map((d) => d.document_id);
    const [tags, concepts, schemes] = await Promise.all([
      ctx.vault.read({
        entity: 'core.tag',
        where: [
          { column: 'target_type', op: 'eq', value: DOCUMENT_TARGET_TYPE },
          { column: 'target_id', op: 'in', value: documentIds },
        ],
        purpose,
      }),
      ctx.vault.read({ entity: 'core.concept', purpose }),
      ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
    ]);
    // Free-form labels (issue #352 phase 4) share ./_shared.js's helper with
    // drive.js — a small extra bounded read over the same matched ids rather
    // than re-deriving from the folder/starred-scoped `tags` read above.
    const tagsByDoc = await readLabelsByDocument({
      ctx,
      purpose,
      documentIds,
      schemes: schemes.rows ?? [],
      concepts: concepts.rows ?? [],
    });

    const scheme = (schemes.rows ?? []).find((s) => s.uri === FOLDER_SCHEME_URI);
    const schemeConcepts = (concepts.rows ?? []).filter(
      (c) => scheme && c.scheme_id === scheme.scheme_id,
    );
    const rootFolderId = schemeConcepts.find((c) => c.notation === 'root')?.concept_id ?? null;

    // A document is a wrapper tagged with a folders-scheme concept.
    const folderConceptIds = new Set(schemeConcepts.map((c) => c.concept_id));
    const folderByDoc = new Map();
    for (const t of tags.rows ?? []) {
      if (folderConceptIds.has(t.concept_id)) folderByDoc.set(t.target_id, t.concept_id);
    }

    // Starred rides the tag read already in hand (issue #274): the flags
    // scheme's `starred` concept against the same matched wrapper ids.
    const flagsScheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
    const starredConceptId = flagsScheme
      ? ((concepts.rows ?? []).find(
          (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
        )?.concept_id ?? null)
      : null;
    const starredIds = new Set(
      (tags.rows ?? [])
        .filter((t) => starredConceptId != null && t.concept_id === starredConceptId)
        .map((t) => t.target_id),
    );

    // The current content join, bounded by the matched wrappers' own
    // current_content_id set. Custody (issue #352 phase 4) rides the same set.
    const contentIds = [...new Set(hits.map((d) => d.current_content_id))];
    const [contents, custodyByContent] = await Promise.all([
      contentIds.length > 0
        ? ctx.vault.read({
            entity: 'core.content_item',
            where: [{ column: 'content_id', op: 'in', value: contentIds }],
            purpose,
          })
        : { rows: [] },
      readCustodyByContent({ ctx, purpose, contentIds }),
    ]);
    const contentById = new Map((contents.rows ?? []).map((c) => [c.content_id, c]));

    // Blob-backed bytes serve as same-origin URLs (issue #296).
    const srcOf = (c) =>
      typeof c?.content_uri === 'string' && c.content_uri.startsWith('blob:')
        ? `/centraid/_vault/blobs/${c.content_id}`
        : c?.content_uri;

    // Vault order is rank order (best match first) — keep it.
    const documents = hits
      .filter((d) => folderByDoc.has(d.document_id))
      .map((d) => {
        const conceptId = folderByDoc.get(d.document_id);
        const c = contentById.get(d.current_content_id);
        return {
          document_id: d.document_id,
          content_id: d.current_content_id,
          title: d.title,
          media_type: c?.media_type ?? null,
          byte_size: c?.byte_size ?? null,
          content_uri: srcOf(c),
          created_at: d.created_at,
          updated_at: d.updated_at,
          folder_id: conceptId === rootFolderId ? null : conceptId,
          starred: starredIds.has(d.document_id),
          trashed: d.deleted_at != null,
          purge_at: d.purge_at ?? null,
          snippet: typeof d._snippet === 'string' ? d._snippet : '',
          tags: tagsByDoc.get(d.document_id) ?? [],
          custody_state: custodyByContent.get(d.current_content_id) ?? null,
        };
      });
    return { documents };
  } catch (err) {
    return { documents: [], vaultDenied: { code: err.code, message: err.message } };
  }
};
