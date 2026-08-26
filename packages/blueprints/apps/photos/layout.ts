// Justified-row timeline layout: pure, DOM-free.
import type { Asset } from "./types.ts";

const GAP = 2;

export const RUNG_LABELS = ["XS", "S", "M", "L"] as const;
export type Rung = 0 | 1 | 2 | 3;

export interface RungTargets {
  desktop: number;
  phone: number;
}

export const RUNGS: readonly RungTargets[] = [
  { desktop: 92, phone: 64 }, // XS
  { desktop: 128, phone: 88 }, // S
  { desktop: 176, phone: 120 }, // M — default
  { desktop: 248, phone: 168 }, // L
];

export const DEFAULT_RUNG: Rung = 2;

// Subtract before packing or rows slide under the rail; CSS reserves it too.
export const RAIL_WIDTH = 14;

export function rungHeight(
  rung: Rung,
  surface: "desktop" | "phone" = "desktop"
): number {
  return RUNGS[rung]![surface];
}

export const ZOOM_LEVELS: readonly number[] = RUNGS.map((r) => r.desktop);
// `number`, not `Rung`: callers walk it by ±1.
export const DEFAULT_ZOOM: number = DEFAULT_RUNG;

// Deliberately not the repo's 720px default.
export const BREAKPOINT = 860;
const SIDEBAR_WIDTH = 250;
const PANE_PADDING = 44;

export function gridWidthFallback(viewportWidth: number): number {
  const wide = viewportWidth >= BREAKPOINT;
  const cw = viewportWidth - (wide ? SIDEBAR_WIDTH : 0) - PANE_PADDING;
  return Math.max(260, cw);
}

function aspect(asset: Asset): number {
  const w = Number(asset.width);
  const h = Number(asset.height);
  return w > 0 && h > 0 ? w / h : 1;
}

export interface JustifiedTile {
  asset: Asset;
  width: number;
  height: number;
}

// Rounding error folds into the last tile so full rows fill exactly.
function emitRow(
  items: { asset: Asset; ar: number }[],
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

// The trailing partial row keeps its natural height and is never stretched.
export function justify(
  list: Asset[],
  containerWidth: number,
  targetHeight: number,
  gap: number = GAP
): JustifiedTile[][] {
  const rows: JustifiedTile[][] = [];
  let row: { asset: Asset; ar: number }[] = [];
  let sum = 0;
  for (const asset of list) {
    const ar = aspect(asset);
    row.push({ asset, ar });
    sum += ar;
    const threshold =
      containerWidth - gap * (row.length - 1) + targetHeight * 0.28;
    if (sum * targetHeight >= threshold) {
      const h = (containerWidth - gap * (row.length - 1)) / sum;
      rows.push(emitRow(row, containerWidth, Math.round(h), gap));
      row = [];
      sum = 0;
    }
  }
  if (row.length) {
    const naturalH = (containerWidth - gap * (row.length - 1)) / sum;
    const h = Math.min(targetHeight * 1.25, naturalH);
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
