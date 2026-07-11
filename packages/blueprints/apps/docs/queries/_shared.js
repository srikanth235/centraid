/**
 * Shared read/join helpers for the docs app's queries (issue #352 phase 4) —
 * pulled out once drive.js and search.js both needed the SAME bounded joins
 * over the same windowed document/content ids: free-form labels
 * (core.tag_item/untag_item over the shared "Tags" scheme —
 * packages/vault/src/commands/tags.ts, shared with notes/tasks) and the
 * blob custody projection
 * (blob.custody_state, blob/custody.ts). Mirrors the photos app's own
 * queries/_shared.js readAssetJoins split, minus the parts specific to media
 * (favorite star and place stay inline in drive.js/search.js — they already
 * ride the SAME core.tag/concept/concept_scheme reads those files make for
 * folders, so factoring them out here would just add a second round trip).
 *
 * NOT a query itself — the dispatcher resolves a query name straight to
 * `queries/<name>.js` (never a directory scan: packages/app-engine/src/
 * handlers/dispatcher.ts), so a plain helper module beside the handlers is
 * invisible to it and to build-manifest.mjs's install-copy walk; nothing
 * needs to know this file exists besides the two callers that import it.
 */

const TAGS_SCHEME_URI = 'centraid:tags:v1';
const DOCUMENT_TARGET_TYPE = 'core.document';

/**
 * Free-form labels for the windowed document ids, keyed by document_id —
 * `{ document_id -> {tag_id, label}[] }`. `schemes`/`concepts` are the SAME
 * core.concept_scheme/core.concept reads the caller already made for the
 * folders scheme (and, in drive.js, the flags scheme) — passed in rather
 * than re-read, since a personal vault's whole concept table is small and
 * already unbounded-read once per query. Each entry carries its tag_id:
 * untag.js removes by tag_id (core.untag_item), not by label.
 */
export async function readLabelsByDocument({ ctx, purpose, documentIds, schemes, concepts }) {
  const tagsByDoc = new Map();
  const tagsScheme = (schemes ?? []).find((s) => s.uri === TAGS_SCHEME_URI);
  if (!tagsScheme || documentIds.length === 0) return tagsByDoc;
  const labelConceptById = new Map(
    (concepts ?? [])
      .filter((c) => c.scheme_id === tagsScheme.scheme_id)
      .map((c) => [c.concept_id, c.pref_label ?? c.notation]),
  );
  const labelTags = await ctx.vault.read({
    entity: 'core.tag',
    where: [
      { column: 'target_type', op: 'eq', value: DOCUMENT_TARGET_TYPE },
      { column: 'target_id', op: 'in', value: documentIds },
    ],
    purpose,
  });
  for (const t of labelTags.rows ?? []) {
    const label = labelConceptById.get(t.concept_id);
    if (!label) continue; // a tag on this document from some OTHER scheme (folders/flags)
    if (!tagsByDoc.has(t.target_id)) tagsByDoc.set(t.target_id, []);
    tagsByDoc.get(t.target_id).push({ tag_id: t.tag_id, label });
  }
  return tagsByDoc;
}

/**
 * The blob custody projection for the windowed CURRENT content ids, keyed by
 * content_id. A content id absent from the map means either its bytes never
 * left vault.db (an inline `data:` document — custody has nothing to track)
 * or the standing sweep simply hasn't run yet; callers render nothing for a
 * missing entry rather than claim a state the vault never asserted.
 */
export async function readCustodyByContent({ ctx, purpose, contentIds }) {
  if (contentIds.length === 0) return new Map();
  const custody = await ctx.vault.read({
    entity: 'blob.custody_state',
    where: [{ column: 'content_id', op: 'in', value: contentIds }],
    purpose,
  });
  return new Map((custody.rows ?? []).map((c) => [c.content_id, c.custody_state]));
}
