// The rule-explaining note (v9 §8, issue #765).
//
// One paragraph, quiet ink, capped at a reading measure. Trivial as CSS and
// deliberately a component anyway: the same sentence-under-a-list shape
// appears on all six ops routes, and six copies of it drifted apart last time.
import type { JSX, ReactNode } from "react";

import { cx } from "./cx.js";

import styles from "./NoteBlock.module.css";

export interface NoteBlockProps {
  /** The sentence. Copy is ALWAYS the caller's — the kit ships no page prose. */
  children: ReactNode;
  className?: string;
}

/** A quiet explanatory line under a block. */
export default function NoteBlock({
  children,
  className,
}: NoteBlockProps): JSX.Element {
  return <p className={cx(styles.note, className)}>{children}</p>;
}
