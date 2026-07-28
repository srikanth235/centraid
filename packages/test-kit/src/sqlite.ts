/**
 * Bun's SQLite driver returns row objects with a driver-owned prototype.
 * Tests assert query data, not that implementation detail, so normalize the
 * rows at the database boundary before using strict equality.
 */
export function plainSqliteRow<T extends object>(
  row: T | undefined,
): { [K in keyof T]: T[K] } | undefined {
  return row === undefined ? undefined : { ...row };
}

/** Normalize every row returned by a SQLite `.all()` query. */
export function plainSqliteRows<T extends object>(
  rows: readonly T[],
): Array<{ [K in keyof T]: T[K] }> {
  return rows.map((row) => plainSqliteRow(row)!);
}
