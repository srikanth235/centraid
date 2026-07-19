/** Canonical SQLite expression used by editable domain-row timestamps. */
export const UPDATED_AT_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

/**
 * Keep `updated_at` meaningful for every write path, including Atlas Browse,
 * imports, and future sync code that does not know a domain command's shape.
 * The WHEN guard makes the self-update terminate even with recursive triggers
 * enabled and still lets an importer preserve an explicit newer timestamp.
 */
export function touchUpdatedAt(table: string, primaryKey: string): string {
  return `
CREATE TRIGGER ${table}_touch_updated_at
AFTER UPDATE ON ${table}
WHEN NEW.updated_at = OLD.updated_at
BEGIN
  UPDATE ${table}
     SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
   WHERE ${primaryKey} = NEW.${primaryKey};
END;`;
}
