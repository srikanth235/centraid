// Keep-originals pin join for free-up-space (issue #864).
//
// Album membership is `core.collection_entry.target_id`. SHA merge keeps one
// canonical `assetId` (the writable copy). The join has to resolve membership
// against every identity the row still answers to — `id`, `assetId`, and
// every folded `assetIds` entry — or a pinned album's originals are offered
// for deletion. `target_type` is polymorphic; only `media.asset` is a photo.
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
