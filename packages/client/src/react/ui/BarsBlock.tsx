// The runs chart (v9 §9, #765).
//
// TWO OUTCOMES, and that is the whole design: succeeded in `--text-faint` ink
// and failed stacked on top in `--net`. No third colour, no gradient, no grid,
// no axis frame, and no SVG — a column of two divs says the same thing and
// stays inside the token system.
//
// It reads as ONE image to assistive tech (`role="img"` + a sentence), because
// twenty-eight nameless rectangles are not an alternative text.
import type { CSSProperties, JSX } from "react";

import { barStack } from "@centraid/design/blocks";

import { cx } from "./cx.js";

import styles from "./BarsBlock.module.css";

/** Past this many columns the gutter costs more plot than it buys legibility,
 *  and the chart tightens to the hairline gap rather than dropping columns. */
const DENSE_COLUMNS = 30;

export interface BarDatum {
  id: string;
  /** The column's own sentence, e.g. "1 failed · day 4". Surfaces as the
   *  column's tooltip — the per-bar detail the single aria-label cannot carry. */
  label: string;
  /** Succeeded height, 0–100, as a share of the plot. */
  ok: number;
  /** Failed height, 0–100, stacked ABOVE the succeeded segment. 0 draws
   *  nothing at all — an empty segment is not a zero-height segment. */
  fail?: number;
}

export interface BarsBlockProps {
  bars: readonly BarDatum[];
  /** The whole chart, as a sentence. "Spend per day over the last 30 days". */
  ariaLabel: string;
  /**
   * The marks along the axis, oldest → newest, spread evenly across the plot.
   *
   * TWO OR MORE, and the count is the caller's (#775) — a window seven days
   * wide has no "halfway" worth naming. A chart that cannot be told what its
   * own axis says ends up telling the reader nothing they can check a spike
   * against.
   */
  axis: readonly string[];
  /**
   * One line under the chart naming what the eye just found — the peak day and
   * what it cost. The chart draws the shape; the note is the only place a
   * column's actual value is ever stated, because a plot with no value axis
   * shows proportion and nothing else.
   */
  note?: string;
  /** The two outcome words. Two, because there are two outcomes. */
  legend?: { ok: string; fail: string };
  /** Shorter plot and tighter columns for the compact form factor. */
  compact?: boolean;
  /**
   * The series has not filled its window yet (#765 follow-up).
   *
   * Columns are `flex: 1` by default, which is right for a window that is
   * FULL — thirty days of spend really are thirty columns across the plot. A
   * series still accumulating is a different picture: ten probes stretched
   * across the same width draw ten slabs, which reads as a solid block rather
   * than as ten marks, and makes a two-minute-old session look like a
   * saturated chart. Capped columns, packed against the newest end, let the
   * strip say "this much so far" and grow into the plot as it earns it.
   */
  partial?: boolean;
  className?: string;
}

/** Stacked outcome columns — the one chart in the block kit. */
export default function BarsBlock({
  bars,
  ariaLabel,
  axis,
  note,
  legend,
  compact,
  partial,
  className,
}: BarsBlockProps): JSX.Element {
  return (
    <div
      className={cx(styles.bars, className)}
      data-compact={compact ? "true" : undefined}
      data-dense={bars.length > DENSE_COLUMNS ? "true" : undefined}
      data-partial={partial && bars.length < DENSE_COLUMNS ? "true" : undefined}
    >
      {/* oxlint-disable-next-line jsx-a11y/prefer-tag-over-role -- #765 an
          `<img>` cannot BE the chart: the columns are DOM elements drawn from
          tokens, and the alternative to `role="img"` here is N nameless
          rectangles in the reading order. The rule's own escape (an `<svg>`
          carrying the role) is the SVG chart v9 removed. */}
      <div aria-label={ariaLabel} className={styles.plot} role="img">
        {bars.map((bar) => {
          // The stacking arithmetic is the shared headless model's, not this
          // renderer's: the failed share is clamped first and the succeeded
          // share takes what is left.
          const stack = barStack({ fail: bar.fail ?? 0, ok: bar.ok });
          return (
            <div
              className={styles.column}
              key={bar.id}
              style={
                {
                  "--bar-fail": stack.fail,
                  "--bar-ok": stack.ok,
                } as CSSProperties
              }
              title={bar.label}
            >
              {stack.hasFail ? (
                <span
                  className={styles.fail}
                  data-stacked={stack.ok > 0 ? "true" : undefined}
                />
              ) : null}
              <span
                className={styles.ok}
                data-stacked={stack.hasFail ? "true" : undefined}
              />
            </div>
          );
        })}
      </div>
      <div className={styles.axis}>
        {axis.map((label) => (
          <span className={styles.axisLabel} key={label}>
            {label}
          </span>
        ))}
      </div>
      {note ? <p className={styles.note}>{note}</p> : null}
      {legend ? (
        <div className={styles.legend}>
          <span className={styles.legendOk}>{legend.ok}</span>
          <span className={styles.legendFail}>{legend.fail}</span>
        </div>
      ) : null}
    </div>
  );
}
