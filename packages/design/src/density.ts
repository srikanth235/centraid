// One 4px base, six rungs, and the scale STOPS there: the largest rhythm step
// is the 32px desktop content margin, so a seventh rung could only be "one more
// than the biggest one".

export interface DensityScale {
  1: number;
  2: number;
  3: number;
  4: number;
  5: number;
  6: number;
}

export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 24,
  6: 32,
} as const satisfies DensityScale;

/** The only two values below the 4px base, NAMED so the exception is claimed
 *  rather than eyeballed: these are seams, not rhythm steps. A third sub-base
 *  value is a system change, never a call-site decision. */
export const subBase = {
  /** The seam between two images in a mosaic — a cut, not a gap. */
  gutter: 2,
  /** The rule inside a tight text stack. */
  hair: 1,
} as const;

/** Invariants, not preferences: below 34px a control stops being hittable,
 *  below 44px a row stops being a tap target. */
export const metrics = {
  /** Every control, UNDER A POINTER; on touch it is `controlTouch`. */
  control: 34,
  /** A FLOOR, not a preference (v7 §C): `--target-min` starts here and only a
   *  `(pointer: fine)` query lowers it, so an unproven surface keeps 44. */
  controlTouch: 44,
  row: 44,
  /** The one control allowed under 34px: a segment is not the primary target. */
  segmented: 28,
  /** The phone narrows the fact-list key column rather than wrapping the key,
   *  so the value edge stays aligned down the list. */
  keyCol: 150,
  keyColTouch: 110,
  /** The navigation stem: never themed, never scrolled away, never resized.
   *  The invariant is the RESERVATION, not the number. */
  stem: 240,
  /** An app's OWN destination rail, pointer only — not a second stem: the stem
   *  answers which app, this answers where in it. On touch the same
   *  destinations are the app band or shelf strip, never hidden behind this. */
  appRail: 232,
  /** Pointer rows only: anywhere this is a target it takes `row`, because 44 is
   *  the floor and this rung may never be spent on a finger. */
  appRailRow: 30,
} as const;

export type MetricKey = keyof typeof metrics;

/** A SEPARATE scale from `spacing`: 18 deliberately does not sit on the 4px
 *  base, because a page margin is the paper's edge to the text block, not a gap
 *  between two things. Only `mobile` is lowered to native (`toNativeTheme`). */
export const pageMargin = {
  desktop: 32,
  mobile: 18,
} as const;

/** Tiers scale ROW HEIGHT and CONTENT PADDING only, never control size; mobile
 *  renders one tier looser than declared. `dense` bottoms out at the control
 *  height: below it a row is no longer a target. */
export const DENSITY_TIERS = {
  comfortable: { pad: spacing[4], row: metrics.row },
  compact: { pad: spacing[3], row: 38 },
  dense: { pad: spacing[2], row: metrics.control },
} as const;

export type DensityTier = keyof typeof DENSITY_TIERS;

/** Loosest first: mobile steps one entry toward `comfortable`. */
export const DENSITY_TIER_NAMES = [
  "comfortable",
  "compact",
  "dense",
] as const satisfies readonly DensityTier[];

export const DEFAULT_DENSITY_TIER: DensityTier = "comfortable";
