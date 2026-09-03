export type MergeDirection = "asc" | "desc";

export interface ScopePage<Row> {
  scopeId: string;
  rows: readonly Row[];
  tail: string | null;
  truncated: boolean;
}

export type MergedRow<Row> = Row & { scope_id: string };

export interface MergeResult<Row> {
  rows: MergedRow<Row>[];
  horizon: string | null;
  horizonScopeIds: string[];
  withheld: number;
  truncated: boolean;
}

export interface MergeOptions<Row> {
  ownScopeId: string;
  sortKey: (row: Row) => string | null | undefined;
  direction: MergeDirection;
  dedupeIdentity: (row: Row) => string;
}

function shallower(a: string, b: string, direction: MergeDirection): boolean {
  return direction === "desc" ? a > b : a < b;
}

function atOrBeforeHorizon(
  value: string,
  horizon: string,
  direction: MergeDirection
): boolean {
  return direction === "desc" ? value >= horizon : value <= horizon;
}

function compareRows<Row>(
  sortKey: (row: Row) => string | null | undefined,
  direction: MergeDirection,
  dedupeIdentity: (row: Row) => string
): (a: MergedRow<Row>, b: MergedRow<Row>) => number {
  return (a, b) => {
    const av = sortKey(a) ?? null;
    const bv = sortKey(b) ?? null;
    if (av !== bv) {
      if (av == null) return 1;
      if (bv == null) return -1;
      return shallower(av, bv, direction) ? -1 : 1;
    }
    const ai = dedupeIdentity(a);
    const bi = dedupeIdentity(b);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  };
}

function horizonOf<Row>(
  pages: readonly ScopePage<Row>[],
  direction: MergeDirection
) {
  const truncated = pages.filter((page) => page.truncated);
  const dated = truncated.filter((page) => page.tail != null);
  let horizon: string | null = null;
  for (const page of dated) {
    if (horizon == null || shallower(page.tail!, horizon, direction))
      horizon = page.tail!;
  }
  const atHorizon = truncated.filter(
    (page) => page.tail === horizon || page.tail == null
  );
  return {
    horizon,
    horizonScopeIds: atHorizon.map((page) => page.scopeId),
    anyTruncated: truncated.length > 0,
  };
}

export function mergeScopePages<Row>(
  pages: readonly ScopePage<Row>[],
  options: MergeOptions<Row>
): MergeResult<Row> {
  const { ownScopeId, sortKey, direction, dedupeIdentity } = options;
  const byIdentity = new Map<string, MergedRow<Row>>();
  for (const page of pages) {
    for (const row of page.rows) {
      const key = dedupeIdentity(row);
      const seen = byIdentity.get(key);
      if (seen && (seen.scope_id === ownScopeId || page.scopeId !== ownScopeId))
        continue;
      byIdentity.set(key, { ...row, scope_id: page.scopeId });
    }
  }

  const { horizon, horizonScopeIds, anyTruncated } = horizonOf(
    pages,
    direction
  );
  const merged = [...byIdentity.values()].sort(
    compareRows(sortKey, direction, dedupeIdentity)
  );
  // Any truncation can hide an unseen null-keyed row — withhold the bucket.
  const safe = merged.filter((row) => {
    const value = sortKey(row);
    if (value == null) return !anyTruncated;
    return horizon == null || atOrBeforeHorizon(value, horizon, direction);
  });

  return {
    rows: safe,
    horizon,
    horizonScopeIds,
    withheld: merged.length - safe.length,
    truncated: anyTruncated,
  };
}
