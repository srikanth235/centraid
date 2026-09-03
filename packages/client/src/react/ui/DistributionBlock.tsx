import type { CSSProperties, JSX } from "react";

import { distributionRows } from "@centraid/design/blocks";
import type { DistributionDatum } from "@centraid/design/blocks";

import { cx } from "./cx.js";

import styles from "./DistributionBlock.module.css";

export interface DistributionBlockProps {
  rows: readonly DistributionDatum[];
  ariaLabel: string;
  unit?: string;
  className?: string;
}

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
            {/* aria-hidden: a progressbar role would announce work in flight. */}
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
