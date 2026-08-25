// Multi-scope identity (#599): `asset_id` is minted per vault, so the UI
// token is `(scope_id, asset_id)` joined by NUL (injective; empty scope is
// solo). Bare `asset_id` parses as ambient so single-scope hosts stay honest.

const SEP = "\u0000";

export interface AssetRef {
  scopeId: string;
  assetId: string;
}

export function assetKey(asset: {
  asset_id: string;
  scope_id?: string | null;
}): string {
  return assetRefKey(asset.scope_id, asset.asset_id);
}

export function assetRefKey(
  scopeId: string | null | undefined,
  assetId: string
): string {
  return `${scopeId ?? ""}${SEP}${assetId}`;
}

export function parseAssetKey(key: string): AssetRef {
  const at = key.indexOf(SEP);
  if (at < 0) return { scopeId: "", assetId: key };
  return { scopeId: key.slice(0, at), assetId: key.slice(at + 1) };
}

export function scopeOfKey(key: string): string | null {
  const { scopeId } = parseAssetKey(key);
  return scopeId === "" ? null : scopeId;
}

export function isAsset(
  asset: { asset_id: string; scope_id?: string | null },
  key: string
): boolean {
  return assetKey(asset) === key;
}
