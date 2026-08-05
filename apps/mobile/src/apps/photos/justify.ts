// Justified-row packing for the timeline (Photos v4 handoff §4.1).
//
// Rows are packed from REAL aspect ratios to a target height, then scaled to
// fill the content width exactly. Nothing is cropped to a square, and nothing
// reflows when bytes land — every tile's box comes from the asset record's
// `width`/`height`, which are known before the bytes are.
//
// This is the same algorithm and the same constants as the web half
// (`packages/blueprints/apps/photos/layout.ts`). Mobile has its own runtime so
// the code is not imported across the boundary; the numbers must stay
// identical, and `justify.test.ts` pins the ones that matter.

import type { PhotoAsset } from "./timeline-model";

/** Gutter between tiles, BOTH axes (§4.1). The 4px base rung halved — the one
 *  place in the product where content touches content. */
export const GAP = 2;

/** The slack that decides "one more tile belongs in this row" versus "this row
 *  is done": 28% of the target height. */
const OVERSHOOT = 0.28;

/** A trailing partial row keeps its natural height rather than stretching a
 *  half-empty row to full width — capped so one wide photograph cannot become
 *  a banner. */
const LAST_ROW_CAP = 1.25;

/** An asset's real aspect ratio. Unknown dimensions fall back to square — the
 *  record is what the tile's shape comes from, and a missing record is the one
 *  case where there is nothing to be faithful to. */
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

/**
 * Turns one packed (full) row into pixel boxes at `rowHeight`. Per-tile
 * rounding can leave the row a pixel or two short of the container; the
 * remainder is folded into the LAST tile so full rows fill the width exactly
 * rather than drifting. The trailing partial row deliberately does not.
 */
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

/**
 * Packs `list` into justified rows filling `containerWidth` at `targetHeight`
 * (§4.1's `pack()`).
 */
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
