import { justify } from "./justify";
import type { JustifiedTile } from "./justify";
import type { PhotoAsset } from "./timeline-model";

export const SKELETON_ASPECTS: readonly number[] = [
  3 / 2,
  1,
  4 / 3,
  3 / 4,
  3 / 2,
  16 / 9,
  1,
  2 / 3,
  4 / 3,
  1,
  3 / 2,
  3 / 4,
];

export function skeletonTileCount(
  containerWidth: number,
  targetHeight: number,
  viewportHeight: number
): number {
  const perRow = Math.max(1, Math.floor(containerWidth / targetHeight)) + 1;
  const rows = Math.max(1, Math.ceil(viewportHeight / targetHeight) + 1);
  return perRow * rows;
}

function placeholderAsset(index: number, aspect: number): PhotoAsset {
  return {
    archived: false,
    backupState: "local-only",
    capturedAt: "",
    deleted: false,
    favorite: false,
    height: 1000,
    id: `skeleton-${index}`,
    kind: "photo",
    originalUri: "",
    previewUri: "",
    source: "device",
    uri: "",
    width: Math.round(1000 * aspect),
  };
}

export function skeletonRows(
  containerWidth: number,
  targetHeight: number,
  tileCount: number
): JustifiedTile[][] {
  if (containerWidth <= 0 || targetHeight <= 0 || tileCount <= 0) return [];
  const assets = Array.from({ length: tileCount }, (_, index) =>
    placeholderAsset(
      index,
      SKELETON_ASPECTS[index % SKELETON_ASPECTS.length] ?? 1
    )
  );
  return justify(assets, containerWidth, targetHeight);
}
