import type { ReactNode } from "react";

// Static placeholder rows standing in for content during the first read —
// no shimmer sweep, no spinner (#707's motion grammar). It emits
// `.kit-skeleton` rows, which `@centraid/design/kit.css` already styles
// (#799). `feedback.ts`'s `showSkeleton`
// is the imperative twin for surfaces with no React tree.
export function Skeleton({ rows = 3 }: { rows?: number }): ReactNode {
  return Array.from({ length: Math.max(0, rows) }, (_, index) => (
    <div className="kit-skeleton" key={`skeleton-row-${index}`} />
  ));
}

export function LoadingSkeleton({ rows = 6 }: { rows?: number }): ReactNode {
  return <Skeleton rows={rows} />;
}
