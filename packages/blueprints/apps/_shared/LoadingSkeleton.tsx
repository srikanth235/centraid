import type { FC, ReactNode } from "react";

const KitSkeleton = "kit-skeleton" as unknown as FC<{ rows?: number }>;

/** Consistent first-read placeholder for bundled blueprint surfaces. */
export function LoadingSkeleton({ rows = 6 }: { rows?: number }): ReactNode {
  return <KitSkeleton rows={rows} />;
}
