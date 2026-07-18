// Justified-row layout math for the Google-Photos-style timeline — a
// faithful port of the reference mockup's `justify()`/`gridWidth()`
// (design-handoff/Photos - Reinvented.dc.html), onto this app's real asset
// shape (`width`/`height`, not the mockup's private `w`/`h`). Pure, DOM-free:
// given a list of assets and a target row height, returns rows of
// `{ asset, width, height }` tiles that fill the container width edge to
// edge (except a shorter, natural-height last row) — the same algorithm,
// unchanged, just renamed fields.
import type { Asset } from './types.ts';

const GAP = 4;

// Four zoom steps (the toolbar's zoom control): target row height in CSS
// pixels. Index 1 ("regular") is the default, same as the mockup.
export const ZOOM_LEVELS = [116, 158, 210, 300];
export const DEFAULT_ZOOM = 1;

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
 * Packs `list` into justified rows filling `containerWidth` at
 * `targetHeight`. The last row keeps its natural height (never taller than
 * the target, never shorter than 72% of it) rather than stretching a
 * half-empty row to full width.
 */
export function justify(
  list: Asset[],
  containerWidth: number,
  targetHeight: number,
): JustifiedTile[][] {
  const rows: JustifiedTile[][] = [];
  let row: { asset: Asset; ar: number }[] = [];
  let sum = 0;
  for (const asset of list) {
    const ar = aspect(asset);
    row.push({ asset, ar });
    sum += ar;
    if (sum * targetHeight + (row.length - 1) * GAP >= containerWidth) {
      const h = (containerWidth - (row.length - 1) * GAP) / sum;
      rows.push(row.map((r) => ({ asset: r.asset, width: r.ar * h, height: h })));
      row = [];
      sum = 0;
    }
  }
  if (row.length) {
    const h = Math.min(targetHeight, (containerWidth - (row.length - 1) * GAP) / sum);
    const clamped = Math.max(h, targetHeight * 0.72);
    rows.push(row.map((r) => ({ asset: r.asset, width: r.ar * clamped, height: clamped })));
  }
  return rows;
}
