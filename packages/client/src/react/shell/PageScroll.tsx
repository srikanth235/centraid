import type { JSX, ReactNode } from "react";

import { cx } from "../ui/cx.js";

import mainScrollCss from "../styles/mainScroll.module.css";
import styles from "./PageScroll.module.css";

export default function PageScroll({
  title,
  subtitle,
  flush,
  children,
}: {
  title?: string;
  subtitle?: string;
  flush?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className={mainScrollCss.hasWall}>
      <div
        className={cx(
          mainScrollCss.mainScroll,
          flush ? mainScrollCss.flush : undefined
        )}
      >
        {title !== undefined || subtitle !== undefined ? (
          <div className={styles.pageHead}>
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
