/**
 * Shared read/join helpers for the docs app's queries (issue #352 phase 4) —
 * pulled out once drive.ts and search.ts both needed the SAME bounded joins
 * over the same windowed document/content ids: free-form labels
 * (core.tag_item/untag_item over the shared "Tags" scheme —
 * packages/vault/src/commands/tags.ts, shared with notes/tasks) and the
 * blob custody projection
 * (blob.custody_state, blob/custody.ts). Mirrors the photos app's own
 * queries/_shared.js readAssetJoins split, minus the parts specific to media
 * (favorite star and place stay inline in drive.ts/search.ts — they already
 * ride the SAME core.tag/concept/concept_scheme reads those files make for
 * folders, so factoring them out here would just add a second round trip).
 *
 * NOT a query itself — the dispatcher resolves a query name straight to
 * `queries/<name>.ts` (never a directory scan: packages/app-engine/src/
 * handlers/dispatcher.ts), so a plain helper module beside the handlers is
 * invisible to it and to build-manifest.mjs's install-copy walk; nothing
 * needs to know this file exists besides the two callers that import it.
 *
 * TS conversion note: the vault read surface returns `Record<string, unknown>`
 * rows (see HandlerCtx.vault), so each raw row set is cast once to a typed
 * shape (`as unknown as X[]`) at its read site — the only place unknown vault
 * columns become named fields. Handler logic is otherwise byte-for-byte the
 * pre-conversion JS.
 */

const TAGS_SCHEME_URI = 'centraid:tags:v1';
const DOCUMENT_TARGET_TYPE = 'core.document';

/** A folders/flags/tags-scheme concept row (the SKOS vocabulary). */
export interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  pref_label?: string;
  notation?: string;
  broader_concept_id?: string | null;
}

/** A concept-scheme row (keyed by its stable URI). */
export interface SchemeRow {
  scheme_id: string;
  uri: string;
}

/** A core.tag edge row. */
export interface TagRow {
  tag_id: string;
  concept_id: string;
  target_id: string;
  target_type?: string;
  tagged_at?: string;
}

/** One free-form label carried by a document, keyed by document_id. */
export interface LabelEntry {
  tag_id: string;
  label: string;
}

interface LabelArgs {
  ctx: HandlerCtx;
  purpose: string;
  documentIds: string[];
  schemes: SchemeRow[];
  concepts: ConceptRow[];
}

/**
 * Free-form labels for the windowed document ids, keyed by document_id —
 * `{ document_id -> {tag_id, label}[] }`. `schemes`/`concepts` are the SAME
 * core.concept_scheme/core.concept reads the caller already made for the
 * folders scheme (and, in drive.ts, the flags scheme) — passed in rather
 * than re-read, since a personal vault's whole concept table is small and
 * already unbounded-read once per query. Each entry carries its tag_id:
 * untag.ts removes by tag_id (core.untag_item), not by label.
 */
export async function readLabelsByDocument({
  ctx,
  purpose,
  documentIds,
  schemes,
  concepts,
}: LabelArgs): Promise<Map<string, LabelEntry[]>> {
  const tagsByDoc = new Map<string, LabelEntry[]>();
  const tagsScheme = (schemes ?? []).find((s) => s.uri === TAGS_SCHEME_URI);
  if (!tagsScheme || documentIds.length === 0) return tagsByDoc;
  const labelConceptById = new Map<string, string | undefined>(
    (concepts ?? [])
      .filter((c) => c.scheme_id === tagsScheme.scheme_id)
      .map((c) => [c.concept_id, c.pref_label ?? c.notation] as const),
  );
  const labelTags = await ctx.vault.read({
    entity: 'core.tag',
    where: [
      { column: 'target_type', op: 'eq', value: DOCUMENT_TARGET_TYPE },
      { column: 'target_id', op: 'in', value: documentIds },
    ],
    purpose,
  });
  for (const t of (labelTags.rows ?? []) as unknown as TagRow[]) {
    const label = labelConceptById.get(t.concept_id);
    if (!label) continue; // a tag on this document from some OTHER scheme (folders/flags)
    if (!tagsByDoc.has(t.target_id)) tagsByDoc.set(t.target_id, []);
    tagsByDoc.get(t.target_id)!.push({ tag_id: t.tag_id, label });
  }
  return tagsByDoc;
}

interface CustodyRow {
  content_id: string;
  custody_state: string;
}

/**
 * The blob custody projection for the windowed CURRENT content ids, keyed by
 * content_id. A content id absent from the map means either its bytes never
 * left vault.db (an inline `data:` document — custody has nothing to track)
 * or the standing sweep simply hasn't run yet; callers render nothing for a
 * missing entry rather than claim a state the vault never asserted.
 */
export async function readCustodyByContent({
  ctx,
  purpose,
  contentIds,
}: {
  ctx: HandlerCtx;
  purpose: string;
  contentIds: string[];
}): Promise<Map<string, string>> {
  if (contentIds.length === 0) return new Map();
  const custody = await ctx.vault.read({
    entity: 'blob.custody_state',
    where: [{ column: 'content_id', op: 'in', value: contentIds }],
    purpose,
  });
  return new Map(
    ((custody.rows ?? []) as unknown as CustodyRow[]).map((c) => [c.content_id, c.custody_state]),
  );
}
