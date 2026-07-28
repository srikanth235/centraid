/**
 * K-way merge of per-scope library pages into ONE photo timeline (issue #599).
 * Pure: no DOM, no IO — it takes what each scope's `queries/library.ts` page
 * returned and decides what the merged grid may show.
 *
 * ORDERING. Newest first by `taken_at`, matching each page's own order. Two
 * assets with the same timestamp tie-break by `asset_id` ascending so the grid
 * is byte-stable across re-reads. Assets with a NULL `taken_at` (undated
 * imports) sort AFTER every dated asset — the same place SQLite's
 * `ORDER BY … DESC` puts them inside a single scope, so merging N scopes keeps
 * one stable undated tail bucket instead of interleaving nulls anywhere.
 *
 * DEDUPE. A photo shared into an audience exists as a row in BOTH the sharer's
 * own scope and the audience scope, so the merged list would show it twice.
 * Identity is `sha256` when the row carries one (identical bytes are the same
 * photo wherever they live) and `content_id` otherwise. When a duplicate spans
 * scopes the OWN-scope copy wins: it is the copy the member can edit, retitle,
 * trash and un-share, so acting on the surviving tile always acts on the thing
 * the member controls. Among two audience copies, the earlier page in the input
 * order wins — deterministic, and the caller controls that order. Each survivor
 * is tagged with `scope_id`: the scope it is shown FROM.
 *
 * THE SHARED SAFE HORIZON — the subtle part. Each page is a bounded window:
 * `truncated` says older assets exist beyond it, and `tail` is the oldest
 * timestamp the window reached. A scope that is truncated is therefore
 * COMPLETE for every timestamp ≥ its own tail and UNKNOWN below it.
 *
 * Merging windows of different depths is what makes this dangerous: if Family
 * reached back to March and Library only to July, everything the merged list
 * shows before July is Family-only — a Library photo from May would appear
 * later, INSERTED above photos already on screen, once Library pages deeper.
 * So the merged list may only extend as deep as the SHALLOWEST truncated
 * scope, i.e. down to the NEWEST (maximum) tail among truncated scopes. That
 * maximum is the horizon. Every scope — truncated or not — is fully known at
 * or above it, so assets with `taken_at ≥ horizon` are safe to show and assets
 * strictly older are withheld until the horizon scopes page deeper.
 * Non-truncated scopes constrain nothing: they already returned everything.
 *
 * A truncated scope whose `tail` is null ran out inside the undated bucket: it
 * still knows every dated asset it has, so it must NOT drag the dated horizon
 * up — such scopes are skipped in the maximum. They do constrain the undated
 * bucket, which is why undated assets are withheld while ANY scope is
 * truncated (they sort below every dated asset, hence below any horizon).
 *
 * `horizonScopeIds` names the truncated scopes sitting AT the horizon (plus,
 * when the horizon is null-tailed only, the truncated scopes generally), so
 * "load more" re-queries exactly those scopes and leaves the settled ones
 * alone.
 */

/** The subset of a library asset row this merge needs; the rest rides along. */
export interface MergeAsset {
  asset_id: string;
  content_id: string;
  sha256?: string | null;
  taken_at?: string | null;
  [key: string]: unknown;
}

/** One scope's `queries/library.ts` page. */
export interface ScopePage {
  scopeId: string;
  assets: readonly MergeAsset[];
  /** The page's oldest `taken_at`, or null (empty page, or an undated tail). */
  tail: string | null;
  truncated: boolean;
}

/** A merged asset, tagged with the scope it is shown from. */
export type MergedAsset = MergeAsset & { scope_id: string };

export interface MergeResult {
  /** Newest-first, deduped, horizon-safe. */
  assets: MergedAsset[];
  /** Oldest timestamp safe to show, or null when nothing is withheld. */
  horizon: string | null;
  /** Scopes to re-query for "load more" — the ones sitting at the horizon. */
  horizonScopeIds: string[];
  /** How many deduped assets the horizon held back. */
  withheld: number;
  /** Whether any scope is still truncated (i.e. "load more" is meaningful). */
  truncated: boolean;
}

export interface MergeOptions {
  /** The member's own scope id — the dedupe winner. */
  ownScopeId: string;
}

const identityOf = (asset: MergeAsset) =>
  asset.sha256 != null && asset.sha256 !== ""
    ? `sha:${asset.sha256}`
    : `content:${asset.content_id}`;

/** Newest first; NULL `taken_at` last; `asset_id` ascending as the tie-break. */
function compareAssets(a: MergedAsset, b: MergedAsset): number {
  const at = a.taken_at ?? null;
  const bt = b.taken_at ?? null;
  if (at !== bt) {
    if (at == null) return 1;
    if (bt == null) return -1;
    return at < bt ? 1 : -1;
  }
  return a.asset_id < b.asset_id ? -1 : a.asset_id > b.asset_id ? 1 : 0;
}

/** The horizon + the scopes sitting at it. See the header for the reasoning. */
function horizonOf(pages: readonly ScopePage[]) {
  const truncated = pages.filter((page) => page.truncated);
  const dated = truncated.filter((page) => page.tail != null);
  let horizon: string | null = null;
  for (const page of dated) {
    if (horizon == null || page.tail! > horizon) horizon = page.tail!;
  }
  // At the horizon: the dated truncated scopes whose tail IS the horizon, plus
  // every null-tailed truncated scope (they cap the undated bucket, and paging
  // them is the only way to lift that cap).
  const atHorizon = truncated.filter(
    (page) => page.tail === horizon || page.tail == null
  );
  return {
    horizon,
    horizonScopeIds: atHorizon.map((page) => page.scopeId),
    anyTruncated: truncated.length > 0,
  };
}

export function mergeScopePages(
  pages: readonly ScopePage[],
  options: MergeOptions
): MergeResult {
  const { ownScopeId } = options;
  const byIdentity = new Map<string, MergedAsset>();
  for (const page of pages) {
    for (const asset of page.assets) {
      const key = identityOf(asset);
      const seen = byIdentity.get(key);
      // Own wins over any audience copy; otherwise first page order wins.
      if (seen && (seen.scope_id === ownScopeId || page.scopeId !== ownScopeId))
        continue;
      byIdentity.set(key, { ...asset, scope_id: page.scopeId });
    }
  }

  const { horizon, horizonScopeIds, anyTruncated } = horizonOf(pages);
  const merged = [...byIdentity.values()].sort(compareAssets);
  // Undated assets sit below every dated one, so any truncation at all can
  // still hide a newer undated row — withhold the whole bucket meanwhile.
  const safe = merged.filter((asset) => {
    if (asset.taken_at == null) return !anyTruncated;
    return horizon == null || asset.taken_at >= horizon;
  });

  return {
    assets: safe,
    horizon,
    horizonScopeIds,
    withheld: merged.length - safe.length,
    truncated: anyTruncated,
  };
}
