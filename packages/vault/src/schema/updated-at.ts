export const UPDATED_AT_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

export function touchUpdatedAt(
  table: string,
  primaryKey: string | readonly string[]
): string {
  return `
CREATE TRIGGER ${table}_touch_updated_at
AFTER UPDATE ON ${table}
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE ${table}
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE ${pkMatch(table, typeof primaryKey === "string" ? [primaryKey] : primaryKey)};
END;`;
}

function pkMatch(table: string, primaryKey: readonly string[]): string {
  if (primaryKey.length === 0)
    throw new Error(`${table}: a lifecycle trigger needs a primary key`);
  return primaryKey.map((column) => `${column} = NEW.${column}`).join(" AND ");
}
