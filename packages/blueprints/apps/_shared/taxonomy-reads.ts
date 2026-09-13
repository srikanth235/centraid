/**
 * THE TAXONOMY PAIR, DECLARED ONCE (#922 0a; paged since #996 wave 4, R8).
 *
 * Eight query handlers across Docs, Notes and People open the same way: read
 * every `core.concept`, read every `core.concept_scheme`, and hand both to
 * `concept-scheme-kit` to resolve tags into labelled shelves. The pair was
 * copy-pasted before this issue and stayed invisible; a bound restated in
 * eight files is eight places to forget when the window changes.
 *
 * Two reads, not one: they are different tables, and each is walked to the end
 * of itself. The helper returns the promises UNAWAITED so a caller can keep
 * them inside the `Promise.all` it already has, in the position its
 * destructuring expects.
 *
 * A VAULT'S VOCABULARY IS THE THING THAT BOUNDS THE REST. It is owner-curated
 * and small, so the walk is honest: `readPages` states its ceiling and throws
 * at it rather than handing back a short taxonomy, which is what the old
 * truncation flag did — and a missing concept there does not read as an error,
 * it reads as an untagged note.
 *
 * `broader_concept_id` IS IN THE PROJECTION BECAUSE TWO READERS NEED IT (#1020,
 * R-1020-35). It was not, and on the gateway's paged door an unselected column
 * reads as `undefined` rather than throwing — so `docs/queries/drive.ts:68`
 * reported EVERY folder as top-level, and `docs/queries/_shared.ts:261` built a
 * `parentOf` map of nothing, which made `folderChain` one step long and a share
 * on a grandparent folder silently stop reaching the document below it.
 * `queries/shares.test.ts`'s grandparent case is the red.
 */

import { readPages } from "./paged-reads.ts";

/** One `core.concept` row, as every caller of the pair projects it. */
export interface TaxonomyConceptRow extends Record<string, unknown> {
  concept_id: string;
  scheme_id?: string | null;
  pref_label?: string | null;
  notation?: string | null;
  /** The parent concept, which is what makes a folder rail a TREE. */
  broader_concept_id?: string | null;
}

/** One `core.concept_scheme` row. */
export interface TaxonomySchemeRow extends Record<string, unknown> {
  scheme_id: string;
  uri?: string | null;
  title?: string | null;
}

interface TaxonomyCtx {
  vault: Pick<VaultApi, "page">;
}

export function conceptTaxonomyReads(
  ctx: TaxonomyCtx
): [Promise<TaxonomyConceptRow[]>, Promise<TaxonomySchemeRow[]>] {
  return [
    readPages<TaxonomyConceptRow>(ctx, {
      name: "_shared/taxonomy.concepts",
      select: "concept_id, scheme_id, pref_label, notation, broader_concept_id",
      from: "core_concept",
      order: {
        sortColumn: "concept_id",
        pkColumn: "concept_id",
        descending: false,
      },
    }),
    readPages<TaxonomySchemeRow>(ctx, {
      name: "_shared/taxonomy.schemes",
      select: "scheme_id, uri, title",
      from: "core_concept_scheme",
      order: {
        sortColumn: "scheme_id",
        pkColumn: "scheme_id",
        descending: false,
      },
    }),
  ];
}
