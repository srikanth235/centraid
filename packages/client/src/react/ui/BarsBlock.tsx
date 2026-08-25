// The runs chart (v9 §9, #765). Two outcomes only: ok `--text-faint`, fail `--net`.
// No third colour, no SVG. Assistive tech reads one image (`role="img"` + a sentence).
import type { CSSProperties, JSX } from "react";

import { barStack } from "@centraid/design/blocks";

import { cx } from "./cx.js";

import styles from "./BarsBlock.module.css";

/** Past this many, tighten to hairline rather than dropping columns. */
const DENSE_COLUMNS = 30;

export interface BarDatum {
  id: string;
  label: string;
  ok: number;
  /** 0 draws nothing — empty is not a zero-height segment. */
  fail?: number;
}

export interface BarsBlockProps {
  bars: readonly BarDatum[];
  ariaLabel: string;
  /** Oldest → newest. TWO OR MORE; the count is the caller's (#775). */
  axis: readonly string[];
  note?: string;
  legend?: { ok: string; fail: string };
  compact?: boolean;
  /**
   * Series has not filled its window (#765). Default `flex: 1` stretches a
   * short series into slabs; cap and pack against the newest end.
   */
  partial?: boolean;
  className?: string;
}

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
