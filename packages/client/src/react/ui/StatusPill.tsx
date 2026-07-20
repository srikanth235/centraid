import type { JSX, ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './StatusPill.module.css';

/** Known tones: 'new' | 'draft' | 'live' (anything else renders ink-3). */
export type StatusTone = string;

export interface StatusPillProps {
  /** Drives the pill color via `data-tone` (new / draft / live). */
  tone?: StatusTone | null;
  children?: ReactNode;
  /** Tighter tracking for dense contexts (card footers). */
  tight?: boolean;
  className?: string;
}

/** Uppercase-mono status pill with a glowing dot (`● live`). */
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
