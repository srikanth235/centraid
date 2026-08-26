// Timeline snapshot → offline thumbnail-pack candidates + change detection.
// `usePhotoTimeline` re-publishes assets every tick; the cheap signature fold
// skips the expensive filesystem pass.

import type { PinnedThumbnailCandidate } from "../../lib/replica/thumbnail-pack";
import type { PhotoAsset } from "./timeline-source";

function foldString(hash: number, value: string): number {
  let next = hash;
  for (let index = 0; index < value.length; index += 1) {
    next = ((next ^ value.charCodeAt(index)) * 0x0100_0193) >>> 0;
  }
  return next;
}

/** Stable identity for the candidate set; `gatewayBase` included. */
export function pinnedThumbnailSignature(
  gatewayBase: string,
  assets: readonly PhotoAsset[]
): string {
  let hash = foldString(0x811c_9dc5, gatewayBase);
  let count = 0;
  let newest = "";
  for (const asset of assets) {
    const contentId = asset.contentId;
    // Device-only rows have no blob; no content id = not backed up yet.
    if (contentId === undefined || asset.source === "device") continue;
    count += 1;
    // Fold "" not `undefined`, which stringifies alike per row.
    const capturedAt = asset.capturedAt ?? "";
    if (capturedAt > newest) newest = capturedAt;
    hash = foldString(hash, contentId);
    hash = foldString(hash, capturedAt);
    hash = foldString(hash, asset.kind);
    hash = foldString(hash, asset.favorite ? "1" : "0");
    for (const scopeId of asset.scopeIds ?? [])
      hash = foldString(hash, scopeId);
  }
  return `${count}:${newest}:${hash.toString(16)}`;
}

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
      // Undated rows sort oldest rather than being dropped.
      capturedAt: asset.capturedAt ?? "",
      favorite: asset.favorite,
    }));
  });
}
