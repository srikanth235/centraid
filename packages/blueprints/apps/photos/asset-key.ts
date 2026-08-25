// The identity of an asset ON A MULTI-SCOPE TIMELINE (#599).
//
// `asset_id` alone stopped being an identity the moment the grid merged N
// scopes. Ids are minted PER VAULT, so two scopes can carry the same
// `asset_id` for two entirely unrelated photos — that is by design, not a
// pathology to be deduped away (`merge.ts` dedupes on `sha256`/`content_id`,
// which is a different question: "are these the same bytes"). Anything that
// keys on the bare id — a selection set, a lookup, a batch command's target —
// would then resolve a colliding id to whichever row it happened to find
// first, and a delete aimed at a Family photo could land on the member's own.
//
// So every UI token that means "this exact row" is the pair
// `(scope_id, asset_id)`, rendered as one opaque string. The separator is NUL,
// which cannot occur in either half (both are ids from the vault, and the
// solo-scope id is the empty string), so `assetKey` is injective and
// `parseAssetKey` is its exact inverse.
//
// The solo case stays invisible: a single-scope mount has an empty scope id,
// so keys are `"\0<assetId>"` and nothing about the behaviour changes — but
// the code path is the SAME one a five-scope household walks, which is what
// keeps the collision from creeping back in.

const SEP = "\u0000";

/** One row on the merged timeline, resolved to exactly one scope. */
export interface AssetRef {
  /** The scope the row is shown from; '' is the ambient/solo scope. */
  scopeId: string;
  assetId: string;
}

/** The composite key for an asset row as the UI holds it. */
export function assetKey(asset: {
  asset_id: string;
  scope_id?: string | null;
}): string {
  return assetRefKey(asset.scope_id, asset.asset_id);
}

/** The same key from its two halves, for callers that hold ids rather than rows. */
export function assetRefKey(
  scopeId: string | null | undefined,
  assetId: string
): string {
  return `${scopeId ?? ""}${SEP}${assetId}`;
}

/**
 * The exact inverse of `assetKey`. A string that is not a key (a bare
 * `asset_id` from an older caller) is read as the ambient scope, which is the
 * only honest answer and keeps single-scope hosts working unchanged.
 */
export function parseAssetKey(key: string): AssetRef {
  const at = key.indexOf(SEP);
  if (at < 0) return { scopeId: "", assetId: key };
  return { scopeId: key.slice(0, at), assetId: key.slice(at + 1) };
}

/** The scope half of a key, as the write path wants it (`''` → ambient). */
export function scopeOfKey(key: string): string | null {
  const { scopeId } = parseAssetKey(key);
  return scopeId === "" ? null : scopeId;
}

/** Does this row have exactly this key? The one identity test the UI uses. */
export function isAsset(
  asset: { asset_id: string; scope_id?: string | null },
  key: string
): boolean {
  return assetKey(asset) === key;
}
