// Justified-row packing for the timeline (Photos v4 handoff §4.1). Rows pack
// from REAL aspect ratios to a target height, then scale to fill the content
// width exactly; nothing crops, nothing reflows when bytes land — tile boxes
// come from the asset record's `width`/`height`. Same algorithm and constants
// as `packages/blueprints/apps/photos/layout.ts`; numbers must stay identical
// (`justify.test.ts` pins them).

import type { PhotoAsset } from "./timeline-model";

/** Gutter between tiles, BOTH axes (§4.1) — the 4px base rung halved. */
export const GAP = 2;

/** Slack deciding whether one more tile belongs in this row: 28% of target height. */
const OVERSHOOT = 0.28;

/** A trailing partial row keeps natural height — capped so one wide photograph cannot become a banner. */
const LAST_ROW_CAP = 1.25;

/** Real aspect ratio; unknown dimensions fall back to square — a missing record is the one case there is nothing to be faithful to. */
export function aspectRatio(asset: PhotoAsset): number {
  const w = Number(asset.width);
  const h = Number(asset.height);
  return w > 0 && h > 0 ? w / h : 1;
}

/** One justified tile: the source asset plus its packed pixel box. */
export interface JustifiedTile {
  asset: PhotoAsset;
  width: number;
  height: number;
}

/** One packed (full) row as pixel boxes at `rowHeight`; per-tile rounding remainder folds into the LAST tile so full rows fill the width exactly. The trailing partial row deliberately does not. */
function emitRow(
  items: readonly { asset: PhotoAsset; ar: number }[],
  containerWidth: number,
  rowHeight: number,
  gap: number
): JustifiedTile[] {
  const available = containerWidth - gap * (items.length - 1);
  const widths = items.map((it) => Math.round(rowHeight * it.ar));
  const used = widths.reduce((a, b) => a + b, 0);
  const lastIndex = widths.length - 1;
  widths[lastIndex] = (widths[lastIndex] ?? 0) + (available - used);
  return items.map((it, i) => ({
    asset: it.asset,
    width: widths[i] ?? 0,
    height: rowHeight,
  }));
}

/** Pack `list` into justified rows filling `containerWidth` at `targetHeight` (§4.1's `pack()`). */
export function justify(
  list: readonly PhotoAsset[],
  containerWidth: number,
  targetHeight: number,
  gap: number = GAP
): JustifiedTile[][] {
  const rows: JustifiedTile[][] = [];
  let row: { asset: PhotoAsset; ar: number }[] = [];
  let sum = 0;
  for (const asset of list) {
    const ar = aspectRatio(asset);
    row.push({ asset, ar });
    sum += ar;
    const threshold =
      containerWidth - gap * (row.length - 1) + targetHeight * OVERSHOOT;
    if (sum * targetHeight >= threshold) {
      const h = (containerWidth - gap * (row.length - 1)) / sum;
      rows.push(emitRow(row, containerWidth, Math.round(h), gap));
      row = [];
      sum = 0;
    }
  }
  if (row.length) {
    const naturalH = (containerWidth - gap * (row.length - 1)) / sum;
    const h = Math.min(targetHeight * LAST_ROW_CAP, naturalH);
    rows.push(
      row.map((r) => ({
        asset: r.asset,
        width: Math.round(h * r.ar),
        height: h,
      }))
    );
  }
  return rows;
}
