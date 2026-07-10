import type { JSX, ReactNode } from 'react';
import { cx } from './cx.js';
import styles from './KindBadge.module.css';

export interface KindBadgeProps {
  kind: 'app' | 'automation';
  /** Badge content — a label, optionally led by a small glyph. */
  children: ReactNode;
  className?: string;
}

/** Small uppercase APP / AUTOMATION classifier chip. */
export default function KindBadge({ kind, children, className }: KindBadgeProps): JSX.Element {
  return (
    <span className={cx(styles.badge, className)} data-kind={kind}>
      {children}
    </span>
  );
}
