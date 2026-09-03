import type { JSX, ReactNode } from "react";

import { cx } from "./cx.js";

import styles from "./NoteBlock.module.css";

export interface NoteBlockProps {
  children: ReactNode;
  className?: string;
}

export default function NoteBlock({
  children,
  className,
}: NoteBlockProps): JSX.Element {
  return <p className={cx(styles.note, className)}>{children}</p>;
}
