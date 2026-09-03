import type { JSX, ReactNode } from "react";

import { cx } from "./cx.js";

import styles from "./KindBadge.module.css";

export interface KindBadgeProps {
  kind: "app" | "automation" | "assistant";
  children: ReactNode;
  className?: string;
}

export default function KindBadge({
  kind,
  children,
  className,
}: KindBadgeProps): JSX.Element {
  return (
    <span className={cx(styles.badge, className)} data-kind={kind}>
      {children}
    </span>
  );
}
