// The distribution block's arithmetic (#775) — the whole of it.
//
// A distribution is a partition said out loud: every run had exactly one
// harness, one model, one effort level and one source, so the rows of a
// breakdown are shares OF A TOTAL and they add up. That is the only claim this
// module makes, and it is the claim a renderer cannot make for itself:
//
//   * the share is measured against the SUM, not against the biggest row. A
//     bar drawn against the maximum makes the top row full-width whatever it
//     actually took, which reads as "all of it" on a window where it took a
//     third. Two rows drawn on different denominators in one view tell two
//     different stories about the same dollars.
//   * a row that measured something is never drawn as nothing. A day of
//     sub-percent spend rounds to 0% and vanishes, so a positive weight keeps a
//     one-percent floor; the FIGURE beside it stays exact.
//   * the biggest share leads. A breakdown sorted by input order is a list;
//     sorted by weight it is an answer.
//
// Units are the renderer's: a CSS custom property takes the number, a native
// style takes a `%` string, so this module stops at the numbers.

import type { DistributionDatum } from "./contracts";

/** A row, with its measured share of the whole. */
export interface DistributionRow extends DistributionDatum {
  /** Share of the total weight, 0–100, floored at 1 for anything positive. */
  share: number;
}

/** The smallest share a row that measured something may be drawn at. */
export const DISTRIBUTION_SHARE_FLOOR = 1;

function weight(datum: DistributionDatum): number {
  const value = datum.weight;
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Order a breakdown and measure each row against the whole.
 *
 * Ties keep the caller's order (the sort is stable), so a rollup that already
 * ranked its rows is not reshuffled by an equal-cost pair.
 */
export function distributionRows(
  data: readonly DistributionDatum[]
): readonly DistributionRow[] {
  const total = data.reduce((sum, datum) => sum + weight(datum), 0);
  return [...data]
    .sort((left, right) => weight(right) - weight(left))
    .map((datum) => {
      const own = weight(datum);
      if (total <= 0 || own <= 0) return { ...datum, share: 0 };
      return {
        ...datum,
        share: Math.max(
          DISTRIBUTION_SHARE_FLOOR,
          Math.min(100, Math.round((own / total) * 100))
        ),
      };
    });
}
