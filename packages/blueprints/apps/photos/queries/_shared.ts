/**
 * Shared read/join helpers for the photos app's queries (issue #352 phase
 * 3/4) — pulled out once queries/library.js and queries/search.js both
 * needed the SAME bounded joins over the same windowed asset/content ids:
 * free-form labels (core.tag_item/untag_item over the shared "Tags" scheme —
 * packages/vault/src/commands/tags.ts, shared with notes/tasks), the
 * linked place (core.place, media.ts's EXIF-GPS auto-link +
 * media.set_asset_place) and the blob custody projection
 * (blob.custody_state, blob/custody.ts).
 *
 * Favorite USED to be joined here too (a flags-scheme starred tag on the
 * canonical content item, issue #274). Issue #419 made it a first-class
 * `favorite` column on media.media_asset — the photos replica shape has to be
 * self-contained, and a native client cannot reconstruct a star from a
 * three-table concept join it was never granted. The tag path is gone, not
 * dual-written: the column is the only source of truth.
 *
 * NOT a query itself — the dispatcher resolves a query name straight to
 * `queries/<name>.js` (never a directory scan: packages/app-engine/src/
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

/** The subset of a content-item row `srcOf` needs to build serve URLs. */
interface SrcContent {
  content_id?: string;
  content_uri?: unknown;
}

interface RawPlace {
  place_id: string;
  name: string;
}

interface SchemeRow {
  scheme_id: string;
  uri: string;
}

interface ConceptRow {
  concept_id: string;
  scheme_id: string;
  pref_label?: string | null;
  notation?: string | null;
}

interface TagRow {
  tag_id: string;
  concept_id: string;
  target_id: string;
  target_type?: string;
}

interface CustodyRow {
  content_id: string;
  custody_state?: string | null;
}

export const BLOB_ROUTE = '/centraid/_vault/blobs';
const TAGS_SCHEME_URI = 'centraid:tags:v1';

/**
 * Blob-backed bytes (issue #296) resolve to same-origin serve URLs (Range,
 * immutable caching, server thumb variants); inline `data:` URIs pass
 * through untouched.
 */
export function srcOf(content: SrcContent | undefined) {
  const uri = content?.content_uri;
  if (typeof uri !== 'string') return { src: null, thumb: null, preview: null, poster: null };
  if (!uri.startsWith('blob:')) return { src: uri, thumb: null, preview: null, poster: null };
  const src = `${BLOB_ROUTE}/${content!.content_id}`;
  return {
    src,
    thumb: `${src}?variant=thumb`,
    preview: `${src}?variant=preview`,
    poster: `${src}?variant=poster`,
  };
}

/**
 * The full known place list (never windowed — a personal vault's place
 * count is small) plus a `place_id -> row` lookup. There is no app-plane
 * command to MINT a brand-new place (only media.set_asset_place, which
 * points an asset at one that already exists, or clears it) — see that
 * command's own doc comment — so this full list is what the lightbox's
 * place picker offers to choose among.
 */
export async function readPlaces({ ctx, purpose }: { ctx: HandlerCtx; purpose: string }) {
  const result = await ctx.vault.read({ entity: 'core.place', purpose });
  const rows = ((result.rows ?? []) as unknown as RawPlace[]).map((p) => ({
    place_id: p.place_id,
    name: p.name,
  }));
  return { rows, byId: new Map(rows.map((p) => [p.place_id, p] as const)) };
}

/**
 * Every bounded per-asset join the grid/lightbox rows need beyond the raw
 * asset/content columns: free-form labels and custody state. Favorite is no
 * longer here — it is a first-class `favorite` column on the asset (issue
 * #419), read straight off the row. Callers pass the WINDOWED asset/content
 * ids only — never a table scan. Returns `{ tagsByAsset, custodyByContent }`.
 */
export async function readAssetJoins({
  ctx,
  purpose,
  assetIds,
  contentIds,
}: {
  ctx: HandlerCtx;
  purpose: string;
  assetIds: string[];
  contentIds: string[];
}) {
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

  // Free-form labels (issue #352): core.tag_item targets the ASSET itself
  // (subject_type 'media.media_asset'), unlike the content-item-scoped
  // favorite star above — see tags.ts's SUBJECT_PK. Each entry carries the
  // tag_id too: untag-asset.js removes by tag_id (core.untag_item), not by
  // label, so the UI needs it to render a working remove control.
  const schemeRows = (schemes.rows ?? []) as unknown as SchemeRow[];
  const conceptRows = (concepts.rows ?? []) as unknown as ConceptRow[];
  const custodyRows = (custody.rows ?? []) as unknown as CustodyRow[];
  const tagsScheme = schemeRows.find((s) => s.uri === TAGS_SCHEME_URI);
  const labelConceptById = new Map<string, string | null | undefined>(
    tagsScheme
      ? conceptRows
          .filter((c) => c.scheme_id === tagsScheme.scheme_id)
          .map((c) => [c.concept_id, c.pref_label ?? c.notation] as const)
      : [],
  );
  const tagsByAsset = new Map<string, Array<{ tag_id: string; label: string }>>();
  if (tagsScheme && assetIds.length > 0) {
    const labelTags = await ctx.vault.read({
      entity: 'core.tag',
      where: [
        { column: 'target_type', op: 'eq', value: 'media.media_asset' },
        { column: 'target_id', op: 'in', value: assetIds },
      ],
      purpose,
    });
    for (const t of (labelTags.rows ?? []) as unknown as TagRow[]) {
      const label = labelConceptById.get(t.concept_id);
      if (!label) continue; // a tag on this asset from some OTHER scheme
      if (!tagsByAsset.has(t.target_id)) tagsByAsset.set(t.target_id, []);
      tagsByAsset.get(t.target_id)!.push({ tag_id: t.tag_id, label });
    }
  }

  const custodyByContent = new Map(
    custodyRows.map((c) => [c.content_id, c.custody_state] as const),
  );

  return { tagsByAsset, custodyByContent };
}
