// The runs chart's native lowering (#765, spec §9).
//
// The arithmetic — segments stack, the failed share is clamped first, a long
// series is tailed rather than sampled — is the shared headless model
// (`@centraid/design/blocks`). What is left here is the unit: a native style
// takes a `%` string, and `null` for a segment that is not drawn, so a bad
// value cannot be spelled.

import { barStack, barWindow } from "@centraid/design/blocks";

/** One column's day, as the caller measured it. */
export interface BarDatum {
  key: string;
  /** Share of the chart height the succeeded runs take, 0–100. */
  succeeded: number;
  /** Share taken by failed runs, stacked ON TOP of `succeeded`, 0–100. */
  failed: number;
  /** What this column is, for the screen reader ("day 3 · 1 failed"). */
  label: string;
}

/** A share of the chart's height, in the one form a style accepts. */
export type BarHeight = `${number}%`;

/** A column, lowered to the two heights the view draws. */
export interface BarColumn {
  key: string;
  label: string;
  succeededHeight: BarHeight | null;
  failedHeight: BarHeight | null;
  hasFailed: boolean;
}

/** Lower one datum to its two segment heights. */
export function barColumn(datum: BarDatum): BarColumn {
  const stack = barStack({ fail: datum.failed, ok: datum.succeeded });
  return {
    failedHeight: stack.hasFail ? `${stack.fail}%` : null,
    hasFailed: stack.hasFail,
    key: datum.key,
    label: datum.label,
    succeededHeight: stack.ok > 0 ? `${stack.ok}%` : null,
  };
}

/** The columns actually drawn — this surface draws a FIXED count. */
export function barColumns(
  data: readonly BarDatum[],
  count: number
): readonly BarColumn[] {
  return barWindow(data, count).map(barColumn);
}
