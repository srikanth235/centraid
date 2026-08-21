// DISTRIBUTION — a breakdown said as labelled proportional rows (#775).
//
// The one shape the block vocabulary was missing, and the reason four
// gateway-computed breakdowns (`byHarness`, `byModel`, `byEffort`, and the
// per-source rollup) shipped on the wire with nothing rendering them: a fact
// list can say "$2.50" but it cannot say "and that is most of it", and the
// stacked-column chart answers "when", not "what share".
//
// Three marks per row and no fourth: the word, the figure in the numeric
// register, and the share — stated as a percentage and drawn as one bar, so the
// comparison survives being read aloud. The bar takes the `Progress` recipe's
// rest (a sunken track, an ink fill, a pill radius), the recipe this system
// named for exactly this and had, until now, no React implementation of. It
// spends NO colour: a breakdown is not news, and `--net` is reserved for what
// leaves the device.
import type { CSSProperties, JSX } from "react";

import { distributionRows } from "@centraid/design/blocks";
import type { DistributionDatum } from "@centraid/design/blocks";

import { cx } from "./cx.js";

import styles from "./DistributionBlock.module.css";

export interface DistributionBlockProps {
  rows: readonly DistributionDatum[];
  /** The whole breakdown, as a sentence — "Spend by harness". */
  ariaLabel: string;
  /** What the shares are shares OF, appended to each row's percentage:
   *  "73% of spend". Absent when the section head already said it. */
  unit?: string;
  className?: string;
}

/**
 * Labelled proportional rows — sorted by weight, measured against the total.
 *
 * The ordering and the arithmetic are the shared headless model's
 * (`distributionRows`), not this renderer's, so the phone cannot draw the same
 * breakdown in a different order or against a different denominator.
 */
export default function DistributionBlock({
  rows,
  ariaLabel,
  unit,
  className,
}: DistributionBlockProps): JSX.Element {
  return (
    <dl aria-label={ariaLabel} className={cx(styles.distribution, className)}>
      {distributionRows(rows).map((row) => (
        <div className={styles.distRow} key={row.id}>
          <dt className={styles.name}>{row.label}</dt>
          <dd className={styles.value}>
            {/* The bar is decoration OF the percentage beside it, so it is
                hidden from assistive tech rather than given a `progressbar`
                role — this is a measurement of what already happened, and
                `progressbar` announces work in flight. */}
            <span
              aria-hidden="true"
              className={styles.track}
              style={{ "--dist-share": row.share } as CSSProperties}
            >
              <span className={styles.fill} />
            </span>
            <span className={styles.share}>
              {row.share}%{unit ? ` ${unit}` : ""}
            </span>
            <span className={styles.amount}>{row.value}</span>
          </dd>
        </div>
      ))}
    </dl>
  );
}
