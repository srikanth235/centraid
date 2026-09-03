export function plainSqliteRow<T extends object>(
  row: T | undefined
): { [K in keyof T]: T[K] } | undefined {
  return row === undefined ? undefined : { ...row };
}

export function plainSqliteRows<T extends object>(
  rows: readonly T[]
): Array<{ [K in keyof T]: T[K] }> {
  return rows.map((row) => plainSqliteRow(row)!);
}
