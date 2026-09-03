import type { PhotoAsset } from "./timeline-model";

type PinAsset = Pick<PhotoAsset, "id" | "assetId" | "contentId" | "assetIds">;

function identities(asset: PinAsset): string[] {
  return [
    asset.assetId,
    asset.id,
    asset.contentId,
    ...(asset.assetIds ?? []),
  ].filter((id): id is string => Boolean(id));
}

export function protectedAssetIdsFromPins(
  entries: readonly Record<string, unknown>[],
  pinnedAlbumIds: readonly string[],
  assets: readonly PinAsset[]
): Set<string> {
  const pinned = new Set(pinnedAlbumIds.map(String));
  const members = new Set<string>();
  for (const row of entries) {
    if (!pinned.has(String(row.collection_id ?? ""))) continue;
    const type = row.target_type;
    if (type != null && String(type) !== "media.asset") continue;
    const target = row.target_id;
    if (target == null || String(target) === "") continue;
    members.add(String(target));
  }
  const protectedIds = new Set<string>();
  for (const asset of assets) {
    const ids = identities(asset);
    if (!ids.some((id) => members.has(id))) continue;
    for (const id of ids) protectedIds.add(id);
  }
  return protectedIds;
}
