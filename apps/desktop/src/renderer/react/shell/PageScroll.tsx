import type { JSX, ReactNode } from 'react';

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
      <div className="cd-main-scroll">
        {title !== undefined || subtitle !== undefined ? (
          <div className="cd-page-head">
            <h1>{title}</h1>
            <p>{subtitle}</p>
          </div>
        ) : null}
        {children}
      </div>
    </div>
  );
}
