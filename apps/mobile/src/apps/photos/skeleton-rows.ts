// The grid IS the loading state (Photos v4 handoff §14, proto:3993-4033).
//
// "A tile knows its shape and its colour before its bytes arrive. Nothing
// reflows when they land." The loading screen is therefore not a message and
// not a spinner — it is the SAME justified grid, packed by the SAME algorithm,
// at the SAME rung, painted in `--skel`. When the real rows arrive they land in
// a layout the member has already been looking at.
//
// Two rules this module exists to hold:
//
//   1. The sequence is FIXED. Random aspect ratios would make the placeholder
//      grid flicker into a different shape on every render — motion that says
//      something is happening when nothing is. `SKELETON_ASPECTS` is a literal.
//   2. The packing is `justify()` itself, not a lookalike. If the timeline's
//      packing ever changes, the skeleton changes with it in the same commit,
//      because there is only one implementation.

import { justify } from "./justify";
import type { JustifiedTile } from "./justify";
import type { PhotoAsset } from "./timeline-model";

/**
 * The shapes a real library actually holds, in a fixed order: portrait and
 * landscape phone frames, squares, the odd wide one. Twelve of them, so a
 * screen's worth of rows never repeats a row's exact rhythm.
 */
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

/** How many placeholder tiles to pack for a given viewport. Deliberately a
 *  little more than fits, so the last row is cut by the screen edge exactly as
 *  a real timeline's is. */
export function skeletonTileCount(
  containerWidth: number,
  targetHeight: number,
  viewportHeight: number
): number {
  // Both halves round UP deliberately: too many placeholder tiles costs a few
  // views that never scroll into sight, while too few leaves a bare strip above
  // the band — which reads as "the library ends here".
  const perRow = Math.max(1, Math.floor(containerWidth / targetHeight)) + 1;
  const rows = Math.max(1, Math.ceil(viewportHeight / targetHeight) + 1);
  return perRow * rows;
}

/**
 * A placeholder asset. Only `width`/`height` are ever read — `justify()` packs
 * from `aspectRatio(asset)` and nothing else — but the record is built whole so
 * this file cannot drift into a cast that silently accepts a changed shape.
 */
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

/**
 * The packed placeholder grid: the same rows `PhotoTimeline` would draw, with
 * no assets behind them.
 */
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
