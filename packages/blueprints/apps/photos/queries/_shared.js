/**
 * Shared read/join helpers for the photos app's queries (issue #352 phase
 * 3/4) — pulled out once queries/library.js and queries/search.js both
 * needed the SAME bounded joins over the same windowed asset/content ids:
 * the favorite star (issue #274, pre-existing), free-form labels
 * (core.tag_entity/untag_entity over the "Labels" scheme —
 * packages/vault/src/commands/tags.ts), the linked place (core.place,
 * media.ts's EXIF-GPS auto-link + media.set_asset_place) and the blob
 * custody projection (blob.custody_state, blob/custody.ts).
 *
 * NOT a query itself — the dispatcher resolves a query name straight to
 * `queries/<name>.js` (never a directory scan: packages/app-engine/src/
 * handlers/dispatcher.ts), so a plain helper module beside the handlers is
 * invisible to it and to build-manifest.mjs's install-copy walk; nothing
 * needs to know this file exists besides the two callers that import it.
 */

export const BLOB_ROUTE = '/centraid/_vault/blobs';
const FLAGS_SCHEME_URI = 'https://centraid.dev/schemes/flags';
const LABELS_SCHEME_URI = 'https://centraid.dev/schemes/labels';

/**
 * Blob-backed bytes (issue #296) resolve to same-origin serve URLs (Range,
 * immutable caching, server thumb variants); inline `data:` URIs pass
 * through untouched.
 */
export function srcOf(content) {
  const uri = content?.content_uri;
  if (typeof uri !== 'string') return { src: null, thumb: null };
  if (!uri.startsWith('blob:')) return { src: uri, thumb: null };
  const src = `${BLOB_ROUTE}/${content.content_id}`;
  return { src, thumb: `${src}?variant=thumb` };
}

/**
 * The full known place list (never windowed — a personal vault's place
 * count is small) plus a `place_id -> row` lookup. There is no app-plane
 * command to MINT a brand-new place (only media.set_asset_place, which
 * points an asset at one that already exists, or clears it) — see that
 * command's own doc comment — so this full list is what the lightbox's
 * place picker offers to choose among.
 */
export async function readPlaces({ ctx, purpose }) {
  const result = await ctx.vault.read({ entity: 'core.place', purpose });
  const rows = (result.rows ?? []).map((p) => ({ place_id: p.place_id, name: p.name }));
  return { rows, byId: new Map(rows.map((p) => [p.place_id, p])) };
}

/**
 * Every bounded per-asset join the grid/lightbox rows need beyond the raw
 * asset/content columns: the favorite star, free-form labels, and custody
 * state. Callers pass the WINDOWED asset/content ids only — never a table
 * scan. Returns `{ starredIds, tagsByAsset, custodyByContent }`.
 */
export async function readAssetJoins({ ctx, purpose, assetIds, contentIds }) {
  const [schemes, concepts, custody] = await Promise.all([
    ctx.vault.read({ entity: 'core.concept_scheme', purpose }),
    ctx.vault.read({ entity: 'core.concept', purpose }),
    contentIds.length > 0
      ? ctx.vault.read({
          entity: 'blob.custody_state',
          where: [{ column: 'content_id', op: 'in', value: contentIds }],
          purpose,
        })
      : { rows: [] },
  ]);

  // Favorite is a flags-scheme starred tag on the canonical content item
  // (issue #274) — one bounded read over the windowed content ids.
  const flagsScheme = (schemes.rows ?? []).find((s) => s.uri === FLAGS_SCHEME_URI);
  const starredConcept = flagsScheme
    ? (concepts.rows ?? []).find(
        (c) => c.scheme_id === flagsScheme.scheme_id && c.notation === 'starred',
      )
    : undefined;
  const starredIds = new Set();
  if (starredConcept && contentIds.length > 0) {
    const starTags = await ctx.vault.read({
      entity: 'core.tag',
      where: [
        { column: 'concept_id', op: 'eq', value: starredConcept.concept_id },
        { column: 'target_type', op: 'eq', value: 'core.content_item' },
        { column: 'target_id', op: 'in', value: contentIds },
      ],
      purpose,
    });
    for (const t of starTags.rows ?? []) starredIds.add(t.target_id);
  }

  // Free-form labels (issue #352): core.tag_entity targets the ASSET itself
  // (target_type 'media.media_asset'), unlike the content-item-scoped
  // favorite star above — see tags.ts's TAGGABLE_TARGETS.
  const labelsScheme = (schemes.rows ?? []).find((s) => s.uri === LABELS_SCHEME_URI);
  const labelConceptById = new Map(
    labelsScheme
      ? (concepts.rows ?? [])
          .filter((c) => c.scheme_id === labelsScheme.scheme_id)
          .map((c) => [c.concept_id, c.pref_label ?? c.notation])
      : [],
  );
  const tagsByAsset = new Map();
  if (labelsScheme && assetIds.length > 0) {
    const labelTags = await ctx.vault.read({
      entity: 'core.tag',
      where: [
        { column: 'target_type', op: 'eq', value: 'media.media_asset' },
        { column: 'target_id', op: 'in', value: assetIds },
      ],
      purpose,
    });
    for (const t of labelTags.rows ?? []) {
      const label = labelConceptById.get(t.concept_id);
      if (!label) continue; // a tag on this asset from some OTHER scheme
      if (!tagsByAsset.has(t.target_id)) tagsByAsset.set(t.target_id, []);
      tagsByAsset.get(t.target_id).push(label);
    }
  }

  const custodyByContent = new Map(
    (custody.rows ?? []).map((c) => [c.content_id, c.custody_state]),
  );

  return { starredIds, tagsByAsset, custodyByContent };
}
