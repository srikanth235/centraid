// The block vocabulary's section head (v9 §8, issue #765).
//
// One label and one count, over a hairline. Every ops screen hand-rolled this
// (`.groupHead`, `.sectionHead`, `.panelHead`…); the shapes had drifted by a
// rung or a gap each. This is the single implementation.
import type { JSX } from "react";

import type { SectionCopy } from "@centraid/design/blocks";

import { cx } from "./cx.js";

import styles from "./SectionBlock.module.css";

export interface SectionBlockProps extends SectionCopy {
  className?: string;
}

/** Section head — uppercase label + truncating numeric meta over a hairline. */
export default function SectionBlock({
  label,
  meta,
  className,
}: SectionBlockProps): JSX.Element {
  return (
    <div className={cx(styles.section, className)}>
      <h2 className={styles.label}>{label}</h2>
      {meta ? <span className={styles.meta}>{meta}</span> : null}
    </div>
  );
}
