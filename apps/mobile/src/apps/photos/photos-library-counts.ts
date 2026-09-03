import type { PhotoAsset } from "./timeline-model";

type CountableAsset = Pick<
  PhotoAsset,
  "favorite" | "archived" | "deleted" | "duplicateHint"
>;

export interface PhotoLibraryCounts {
  favorites: number;
  archived: number;
  deleted: number;
  duplicates: number;
}

export function photoLibraryCounts(
  assets: readonly CountableAsset[]
): PhotoLibraryCounts {
  const counts: PhotoLibraryCounts = {
    favorites: 0,
    archived: 0,
    deleted: 0,
    duplicates: 0,
  };
  for (const asset of assets) {
    if (asset.favorite) counts.favorites += 1;
    if (asset.archived) counts.archived += 1;
    if (asset.deleted) counts.deleted += 1;
    if (asset.duplicateHint) counts.duplicates += 1;
  }
  return counts;
}

export interface FaceReviewCounts {
  people: number;
  proposals: number;
}

export function faceReviewCounts(
  rows: readonly Record<string, unknown>[]
): FaceReviewCounts {
  const parties = new Set<string>();
  let proposals = 0;
  for (const row of rows) {
    if (row.party_id) parties.add(String(row.party_id));
    if (row.review_state === "proposed") proposals += 1;
  }
  return { people: parties.size, proposals };
}
