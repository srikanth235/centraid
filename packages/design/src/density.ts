// Centraid's fixed spacing scale and the three density tiers.
//
// One 4px base, six rungs — 4 / 8 / 12 / 16 / 24 / 32. The 48px rung retired
// with the Binding Layer flip: the system's largest rhythm step is the 32px
// desktop content margin, and a seventh rung only ever existed as "one more
// than the biggest one", which is how a scale stops being a scale.

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

/**
 * The only two values below the 4px base, and the reason they are NAMED.
 *
 * v7 measured fifteen sub-base gaps in the reference — 1, 2, 3, 5 and 6px —
 * and folded thirteen of them back onto the scale. Two survive because they
 * are not spacing at all: they are seams, and a seam is a line rather than a
 * rhythm step. Naming them is what makes the difference enforceable. A loose
 * `gap: 2px` is indistinguishable from someone eyeballing a rung; a
 * `var(--sp-gutter)` says which of the two exceptions is being claimed.
 *
 * Nothing else under 4px is permitted. A third sub-base value is a system
 * change, not a call-site decision.
 */
export const subBase = {
  /** The seam between two images in a mosaic — a cut, not a gap. */
  gutter: 2,
  /** The rule inside a tight text stack. */
  hair: 1,
} as const;

/**
 * Component metrics. These are invariants, not preferences: a control below
 * 34px stops being reliably hittable, a row below 44px stops being a tap
 * target, and the stem is the one band whose width may never change.
 */
export const metrics = {
  /** Every control — button, field, select — is exactly this tall UNDER A
   *  POINTER. On touch it is `controlTouch`; see below. */
  control: 34,
  /**
   * A control on touch, without exception (v7 §C).
   *
   * The one axis the system has is pointer-or-touch, and this is the number
   * that axis exists to carry. The audit found controls sitting at 34 on the
   * phone because the surface was re-decided by hand at the call site — under
   * the 44px floor, on the surface where the floor is not advisory. It is a
   * FLOOR, not a preference: `--target-min` starts here and only a `(pointer:
   * fine)` query lowers it to `control`, so a surface that never proves it has
   * a pointer keeps 44.
   */
  controlTouch: 44,
  /** A list/table row at the comfortable tier. */
  row: 44,
  /** A segmented control, the one control allowed to sit under 34px because
   *  its segments are not individually the primary target. */
  segmented: 28,
  /**
   * The fact-list key column — the fixed inline-start column that holds a
   * `micro` uppercase key beside its value in a facts panel. 150 under a
   * pointer, 110 on touch (v9 surface axis `keyCol`): the phone narrows the
   * column rather than wrapping the key, so the value edge stays aligned
   * down the whole list.
   */
  keyCol: 150,
  keyColTouch: 110,
  /**
   * The navigation stem. Never themed, never scrolled away, never resized.
   *
   * 240 rather than the 92 the first Binding Layer cut shipped: at 92 the
   * launcher is a column of chips with a caption under each, so the vault you
   * are in and the gateway holding it had nowhere to live and were pushed into
   * Home's app bar — where they are only true on one route. The invariant was
   * always the RESERVATION (one band, one width, never themed, mirrors under
   * RTL), not the number; widening it lets identity sit at the head and
   * Settings at the foot, which is where a member reaches for them.
   */
  stem: 240,
} as const;

export type MetricKey = keyof typeof metrics;

/**
 * The PAGE MARGIN — the inset from the viewport edge to page content.
 *
 * A separate scale from `spacing`, exactly as the v4 handoff keeps it
 * separate: its rhythm table carries `gap` (the six rungs above) and
 * `margin:{d:32,m:18}` side by side (`R`, handoff line 3356). The desktop
 * value coincides with `spacing[6]`; the mobile value, 18, does NOT sit on
 * the 4px scale and is not supposed to — a page margin is the distance from
 * the paper's edge to the text block, not a gap between two things, so it is
 * tuned against the phone's own width rather than snapped to a gap rung.
 *
 * Without this token a phone screen has to choose between hard-coding 18 and
 * substituting a rung that is visibly wrong (16 crowds the edge, 24 wastes a
 * quarter-inch of a 390pt viewport), which is how Home and Photos ended up
 * disagreeing about where the page starts.
 *
 * Only the mobile value is lowered to native (`toNativeTheme`), because the
 * desktop margin is a shell/blueprint concern and native never draws it.
 */
export const pageMargin = {
  /** Desktop and the wide web shell. */
  desktop: 32,
  /** The phone. Every native screen's horizontal page inset. */
  mobile: 18,
} as const;

/**
 * Density tiers scale ROW HEIGHT and CONTENT PADDING only — never control
 * size. An app declares its tier; the shell writes it as a `data-density`
 * attribute and every row/padding site reads `--density-row` / `--density-pad`
 * instead of hard-coding a rung. Mobile renders one tier looser than declared.
 *
 * `dense` bottoms out at the 34px control height for the same reason the
 * control does: below it a row is no longer a target.
 */
export const DENSITY_TIERS = {
  comfortable: { pad: spacing[4], row: metrics.row },
  compact: { pad: spacing[3], row: 38 },
  dense: { pad: spacing[2], row: metrics.control },
} as const;

export type DensityTier = keyof typeof DENSITY_TIERS;

/** Tier order, loosest first — mobile steps one entry toward `comfortable`. */
export const DENSITY_TIER_NAMES = [
  "comfortable",
  "compact",
  "dense",
] as const satisfies readonly DensityTier[];

/** The default tier an app inherits when it declares none. */
export const DEFAULT_DENSITY_TIER: DensityTier = "comfortable";
