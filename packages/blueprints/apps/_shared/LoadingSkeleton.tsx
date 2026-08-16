import type { ReactNode } from "react";

// Static placeholder rows standing in for content during the first read —
// no shimmer sweep, no spinner (#707's motion grammar). This was the
// `<kit-skeleton>` custom element until #799 retired the element layer's
// presentation primitives; it emits the same `.kit-skeleton` rows, which
// `@centraid/design/kit.css` already styles. `feedback.ts`'s `showSkeleton`
// is the imperative twin for surfaces with no React tree.
export function Skeleton({ rows = 3 }: { rows?: number }): ReactNode {
  return Array.from({ length: Math.max(0, rows) }, (_, index) => (
    <div className="kit-skeleton" key={`skeleton-row-${index}`} />
  ));
}

/** Consistent first-read placeholder for bundled blueprint surfaces. */
export function LoadingSkeleton({ rows = 6 }: { rows?: number }): ReactNode {
  return <Skeleton rows={rows} />;
}
