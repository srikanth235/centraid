// The runs chart's arithmetic (#765, spec §9) — the whole of it.
//
// The chart draws TWO outcomes stacked in one column, and the only two claims
// it makes that a renderer cannot make for itself are here: the segments stack
// rather than overlap (so the pair can never exceed the plot), and a series
// longer than the chart is TAILED rather than sampled. Both are the same on
// DOM and on React Native; only the units differ (a CSS custom property takes
// the number, a native style takes a `%` string), so this module stops at the
// numbers.

/** One column's two measured shares of the plot height, 0–100. */
export interface BarSegments {
  /** Runs that succeeded. */
  ok: number;
  /** Runs that failed. Stacked ON TOP of `ok`. */
  fail: number;
}

/** The same two shares, made safe to draw. */
export interface BarStack extends BarSegments {
  /** Whether a failed segment is drawn at all. A zero-height segment and no
   *  segment are different things: the first still spends the one colour. */
  hasFail: boolean;
}

function clamp(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(value, ceiling);
}

/**
 * Stack one column's segments.
 *
 * The failed share is clamped FIRST and the succeeded share takes what is
 * left, because failure is the fact the chart exists to show: if the two
 * cannot both fit, the one that gets truncated is the good news.
 */
export function barStack(segments: BarSegments): BarStack {
  const fail = clamp(segments.fail, 100);
  return { fail, hasFail: fail > 0, ok: clamp(segments.ok, 100 - fail) };
}

/**
 * The columns actually drawn, when the chart has a fixed count.
 *
 * A longer series is tailed to its most recent columns; a shorter one is drawn
 * as it is rather than padded, because empty days at the head of a chart read
 * as outages. A surface that draws every column it is given does not call this.
 */
export function barWindow<T>(
  series: readonly T[],
  count: number
): readonly T[] {
  return series.slice(Math.max(0, series.length - count));
}
