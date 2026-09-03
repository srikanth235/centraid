import type { PhotoAsset } from "./timeline-model";

export const GAP = 2;

const OVERSHOOT = 0.28;

const LAST_ROW_CAP = 1.25;

export function aspectRatio(asset: PhotoAsset): number {
  const w = Number(asset.width);
  const h = Number(asset.height);
  return w > 0 && h > 0 ? w / h : 1;
}

export interface JustifiedTile {
  asset: PhotoAsset;
  width: number;
  height: number;
}

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
