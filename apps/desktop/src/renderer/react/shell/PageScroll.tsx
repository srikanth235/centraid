import type { JSX, ReactNode } from 'react';
import mainScrollCss from '../styles/mainScroll.module.css';
import { cx } from '../ui/cx.js';
import styles from './PageScroll.module.css';

// Port of the vanilla `pageScroll` — the standard `.has-wall > .cd-main-scroll`
// page body the shell frame hosts, with an optional `.cd-page-head` title row.
// Screens that own their own header (Insights) omit title/subtitle. `flush`
// drops the standard page padding for screens whose content owns its own
// spacing (the Day-1 home hero — vanilla's `.cd-day1-scroll`).
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
      <div className={cx(mainScrollCss.mainScroll, flush ? mainScrollCss.flush : undefined)}>
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
