// The runs chart (v9 §9, issue #765).
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
  /** The whole chart, as a sentence. "Runs per day over the last 30 days". */
  ariaLabel: string;
  /** Exactly three: the window's start, its middle, and today. */
  axis: readonly [string, string, string];
  /** The two outcome words. Two, because there are two outcomes. */
  legend?: { ok: string; fail: string };
  /** Shorter plot and tighter columns for the compact form factor. */
  compact?: boolean;
  className?: string;
}

/** Stacked outcome columns — the one chart in the block kit. */
export default function BarsBlock({
  bars,
  ariaLabel,
  axis,
  legend,
  compact,
  className,
}: BarsBlockProps): JSX.Element {
  return (
    <div
      className={cx(styles.bars, className)}
      data-compact={compact ? "true" : undefined}
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
      {legend ? (
        <div className={styles.legend}>
          <span className={styles.legendOk}>{legend.ok}</span>
          <span className={styles.legendFail}>{legend.fail}</span>
        </div>
      ) : null}
    </div>
  );
}
