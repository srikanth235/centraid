import type { JSX, ReactNode } from 'react';
import mainScrollCss from '../styles/mainScroll.module.css';
import styles from './PageScroll.module.css';

// Port of the vanilla `pageScroll` — the standard `.has-wall > .cd-main-scroll`
// page body the shell frame hosts, with an optional `.cd-page-head` title row.
// Screens that own their own header (Insights) omit title/subtitle.
export default function PageScroll({
  title,
  subtitle,
  children,
}: {
  title?: string;
  subtitle?: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div className="has-wall">
      <div className={mainScrollCss.mainScroll}>
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
