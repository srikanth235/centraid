// Justified-row layout math for the Google-Photos-style timeline (v4 design
// handoff, design_handoff_photos/README.md §4.1-4.2). Pure, DOM-free: given a
// list of assets and a target row height, returns rows of
// `{ asset, width, height }` tiles that fill the container width edge to edge
// (except a shorter, natural-height last row) — nothing is cropped to a
// square, and nothing reflows when bytes land, because every tile's shape
// comes from the asset record's `width`/`height` columns, known before the
// bytes arrive.
import type { Asset } from "./types.ts";

// Gutter between tiles, BOTH axes (row gap is a plain CSS margin the caller
// applies between `.row` elements; this constant is the one this module's own
// math needs — the horizontal gap eaten out of the row's content width).
const GAP = 2;

// The four tile-size "rungs" (v4 §4.2): a member's zoom preference is stored
// as ONE index (0-3), not a per-surface pixel value — each surface maps that
// index to its own target row height in CSS pixels. This blueprint mounts on
// desktop (Electron) and the installable PWA, which share the "Desktop/PWA"
// column; the "phone" column is here so the table matches the handoff
// one-for-one and stays available to a future compact/native surface without
// re-deriving it.
export const RUNG_LABELS = ["XS", "S", "M", "L"] as const;
export type Rung = 0 | 1 | 2 | 3;

export interface RungTargets {
  /** Target row height (px) on desktop/Electron and the installable PWA. */
  desktop: number;
  /** Target row height (px) on a phone-width surface. */
  phone: number;
}

/** Index 0-3 = XS/S/M/L, matching `RUNG_LABELS`. */
export const RUNGS: readonly RungTargets[] = [
  { desktop: 92, phone: 64 }, // XS
  { desktop: 128, phone: 88 }, // S
  { desktop: 176, phone: 120 }, // M — default
  { desktop: 248, phone: 168 }, // L
];

export const DEFAULT_RUNG: Rung = 2; // M

/**
 * The scrub rail's column (§4.5), in CSS pixels. On desktop/PWA it is a real
 * column on the trailing edge of the content area, so the packer's container
 * width is the pane MINUS this — otherwise every full row overshoots by 14px
 * and the last tile in it slides under the rail. On the phone the rail
 * overlays and this is not subtracted. One constant, because the CSS reserve
 * (`Timeline.module.css .stream`) and the packing budget must never disagree.
 */
export const RAIL_WIDTH = 14;

/** Resolves a stored rung index to this surface's target row height (px). */
export function rungHeight(
  rung: Rung,
  surface: "desktop" | "phone" = "desktop"
): number {
  return RUNGS[rung]![surface];
}

// This blueprint is desktop/PWA-only today, so its zoom control just walks
// the desktop column — same shape the toolbar/app-root already consumed
// (a flat array of pixel heights plus a default index) before v4.
export const ZOOM_LEVELS: readonly number[] = RUNGS.map((r) => r.desktop);
// Widened to `number` (not `Rung`) on purpose: app-root.tsx's `zoomIndex`
// is a plain mutable counter walked by +/-1 across the whole array, not a
// value confined to the rung type.
export const DEFAULT_ZOOM: number = DEFAULT_RUNG;

// The sidebar/drawer breakpoint (~860px) called out explicitly in the build
// prompt — deliberately NOT this repo's general 720px default; see app.css's
// header comment for why. `layout.ts` doesn't use this for CSS (that's a
// plain `@media` rule), only as the matching pixel budget for
// `gridWidthFallback` below, kept in one place so the two never drift.
export const BREAKPOINT = 860;
const SIDEBAR_WIDTH = 250;
const PANE_PADDING = 44; // the scroll region's own left+right padding

// The scroll pane's real content width, read straight off its element by
// the caller (a ResizeObserver in app.tsx) — the accurate source of truth.
// This fallback only covers the sliver of time before the first measurement
// lands (or environments with no layout at all, e.g. the jsdom boot test).
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

/** One justified tile: the source asset plus its packed pixel box. */
export interface JustifiedTile {
  asset: Asset;
  width: number;
  height: number;
}

/**
 * Turns one packed (full) row's aspect ratios into pixel tile boxes at
 * `rowHeight`. Per-tile `round(rowHeight * aspectRatio)` rounding can leave
 * the row a pixel or two short of (or over) the container width; the
 * remainder is folded into the LAST tile so full rows fill the content width
 * exactly, edge to edge, rather than drifting by rounding error. The trailing
 * partial row (see `justify` below) deliberately does NOT do this, since it
 * is allowed to fall short of the full width.
 */
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

/**
 * Packs `list` into justified rows filling `containerWidth` at
 * `targetHeight` (v4 §4.1's `pack()`). A row closes once its accumulated
 * aspect ratio, stretched to `targetHeight`, would overshoot the container
 * width by more than 28% of `targetHeight` — the same slack the reference
 * algorithm uses to decide "one more tile belongs in this row" versus
 * "this row is done". The trailing partial row keeps its natural height
 * (capped at `targetHeight * 1.25`) instead of stretching a half-empty row
 * out to full width.
 */
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
    // Not stretched to fill the row: no rounding-remainder redistribution —
    // each tile just takes its own natural width at this height.
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
