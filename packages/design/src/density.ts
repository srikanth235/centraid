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
 * Component metrics. These are invariants, not preferences: a control below
 * 34px stops being reliably hittable, a row below 44px stops being a tap
 * target, and the stem is the one band whose width may never change.
 */
export const metrics = {
  /** Every control — button, field, select — is exactly this tall. */
  control: 34,
  /** A list/table row at the comfortable tier. */
  row: 44,
  /** A segmented control, the one control allowed to sit under 34px because
   *  its segments are not individually the primary target. */
  segmented: 28,
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
