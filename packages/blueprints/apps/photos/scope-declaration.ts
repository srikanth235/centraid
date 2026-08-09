// The three lines that make Photos lendable (issue #726 D11): everything a
// share needs to know about this app's rows, declared once against the
// shared kit (apps/_shared/scope-kit.ts) — no sharing code of Photos' own.
import type { ScopeAppDeclaration } from "../_shared/scope-kit.ts";

/** The subset of an Asset row the scope declaration and its merge calls
 *  need; the rest rides along untouched through a cast at each call site
 *  (library-store.ts, search.ts) — the same boundary `merge.ts` drew before
 *  this extraction, between the vault's `Asset` projection and what a
 *  cross-scope merge actually reads. */
export interface MergeableAsset {
  asset_id: string;
  content_id: string;
  sha256?: string | null;
  taken_at?: string | null;
  [key: string]: unknown;
}

export const photosScopeDeclaration: ScopeAppDeclaration<MergeableAsset> = {
  mergeKey: (asset) => asset.taken_at ?? null,
  mintedIdFamilies: [
    "media.media_asset",
    "core.collection",
    "core.place",
    "media.memory",
  ],
  projectionIngest: "photos.reingest",
};

/** The cross-scope identity two Asset rows are deduped on: identical bytes
 *  (`sha256`) are the same photo wherever they live; failing that, the same
 *  content row. Declared once here rather than at each `mergeScopePages`
 *  call site (library-store.ts's windowed timeline, search.ts's unbounded
 *  fan-out). */
export function photoDedupeIdentity(asset: MergeableAsset): string {
  return asset.sha256 != null && asset.sha256 !== ""
    ? `sha:${asset.sha256}`
    : `content:${asset.content_id}`;
}
