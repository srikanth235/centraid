import type { JSX, ReactNode } from "react";

import { cx } from "./cx.js";

import styles from "./StatusPill.module.css";

export type StatusTone = string;

export interface StatusPillProps {
  tone?: StatusTone | null;
  children?: ReactNode;
  tight?: boolean;
  className?: string;
}

export default function StatusPill({
  tone,
  children,
  tight,
  className,
}: StatusPillProps): JSX.Element {
  return (
    <span
      className={cx(styles.status, tight && styles.tight, className)}
      data-testid="status-pill"
      data-tone={tone ?? undefined}
    >
      <span className={styles.dot} />
      {children}
    </span>
  );
}
