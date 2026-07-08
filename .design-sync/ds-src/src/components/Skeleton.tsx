export interface SkeletonProps {
  /** How many skeleton blocks to render. */
  rows?: number;
  /** Shape modifier — line, title, row, or circle. */
  variant?: 'line' | 'title' | 'row' | 'circle';
  /** Optional explicit width (any CSS length). */
  width?: string;
}

/** Loading placeholder — shimmering blocks shown while vault data resolves. */
export function Skeleton({ rows = 3, variant, width }: SkeletonProps) {
  const cls = variant ? `kit-skeleton kit-skeleton-${variant}` : 'kit-skeleton';
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className={cls} style={width ? { width } : undefined} />
      ))}
    </>
  );
}
