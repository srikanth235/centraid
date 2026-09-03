import type { ReactNode } from "react";

export function Skeleton({ rows = 3 }: { rows?: number }): ReactNode {
  return Array.from({ length: Math.max(0, rows) }, (_, index) => (
    <div className="kit-skeleton" key={`skeleton-row-${index}`} />
  ));
}

export function LoadingSkeleton({ rows = 6 }: { rows?: number }): ReactNode {
  return <Skeleton rows={rows} />;
}
