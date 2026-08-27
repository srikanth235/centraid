// The Library index's head counts (#880).
//
// Five of these numbers are folds over the MERGED timeline — every device
// photo and every replica row the phone knows about. Written inline in the
// head's JSX they were five separate passes over that array on every render of
// the screen, including renders caused by nothing more than the refresh
// spinner turning or the create-album dialog opening. One pass, computed here
// so the screen can memoize it against the array identity.
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
  /** Distinct named parties; an unnamed region belongs to nobody yet. */
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
