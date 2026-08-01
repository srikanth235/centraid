// Turning a timeline snapshot into offline thumbnail-pack candidates, and
// deciding whether that set actually changed.
//
// `usePhotoTimeline` re-publishes its assets array on every replica tick, so a
// naive effect kicked off a whole pack refresh — a stat of every pinned file
// plus any missing downloads — many times a minute for an unchanged library.
// The signature below is the cheap thing that lets the expensive thing be
// skipped: one O(assets) fold with no per-row allocation, versus an O(assets)
// filesystem pass.

import type { PinnedThumbnailCandidate } from "../../lib/replica/thumbnail-pack";
import type { PhotoAsset } from "./timeline-source";

/** FNV-1a, 32-bit. Chosen for being one multiply per character, not for cryptography. */
function foldString(hash: number, value: string): number {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next = ((next ^ value.charCodeAt(index)) * 0x0100_0193) >>> 0;
  }
  return next;
}

/**
 * A stable identity for the candidate set a snapshot would produce.
 *
 * Folds in everything the candidate URLs and the pack's own retention rules
 * read — content id, scopes, kind, capture time, favourite flag — plus the
 * gateway base the URLs are built from, so re-pairing to a different gateway
 * counts as a change. Equal signatures mean an equal set of downloads.
 */
export function pinnedThumbnailSignature(
  gatewayBase: string,
  assets: readonly PhotoAsset[]
): string {
  let hash = foldString(0x811c_9dc5, gatewayBase);
  let count = 0;
  let newest = "";
  for (const asset of assets) {
    const contentId = asset.contentId;
    // A device-only row has no gateway blob to pin, and a row without a content
    // id has not been backed up yet — neither can produce a candidate.
    if (contentId === undefined || asset.source === "device") continue;
    count += 1;
    if (asset.capturedAt > newest) newest = asset.capturedAt;
    hash = foldString(hash, contentId);
    hash = foldString(hash, asset.capturedAt);
    hash = foldString(hash, asset.kind);
    hash = foldString(hash, asset.favorite ? "1" : "0");
    for (const scopeId of asset.scopeIds ?? [])
      hash = foldString(hash, scopeId);
  }
  return `${count}:${newest}:${hash.toString(16)}`;
}

/** One candidate per (asset, scope) — the pack budget is enforced per scope. */
export function pinnedThumbnailCandidates(
  gatewayBase: string,
  assets: readonly PhotoAsset[]
): PinnedThumbnailCandidate[] {
  return assets.flatMap((asset) => {
    const contentId = asset.contentId;
    if (contentId === undefined || asset.source === "device") return [];
    const variant = asset.kind === "video" ? "poster" : "thumb";
    return (asset.scopeIds ?? []).map((scopeId) => ({
      contentId,
      scopeId,
      uri: `${gatewayBase}/centraid/_gateway/blobs/${encodeURIComponent(
        scopeId
      )}/${encodeURIComponent(contentId)}?variant=${variant}`,
      capturedAt: asset.capturedAt,
      favorite: asset.favorite,
    }));
  });
}
