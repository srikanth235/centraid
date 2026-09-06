/** Canonical SQLite expression used by editable domain-row timestamps. */
export const UPDATED_AT_DEFAULT = "(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))";

/** The column every touched table carries (#996, R6). */
export const ROW_VERSION_COLUMN =
  "row_version INTEGER NOT NULL DEFAULT 1 CHECK (row_version >= 1)";

/**
 * Keep `updated_at` meaningful for every write path, including Atlas Browse,
 * imports, and future sync code that does not know a domain command's shape —
 * and, since #996 (R6), BUMP `row_version` in the same trigger.
 *
 * ONE TRIGGER, TWO FACTS, BECAUSE THEY ARE THE SAME FACT: "this row changed".
 * A second trigger would be a second chance to forget one, and the version an
 * intent's conflict check compares against would then be true for some writers
 * and not others.
 *
 * THE GUARD MOVED FROM `updated_at` TO `row_version`. It still makes the
 * self-update terminate under recursive triggers, and it still lets an
 * importer preserve an explicit newer timestamp — but a writer that sets
 * `updated_at` by hand no longer skips the version bump, which is exactly the
 * writer a stale-base check must not miss. A caller that sets `row_version`
 * itself — the seat applier replaying the gateway's own value (R5) — is the
 * one path that passes through untouched, and that is the point: a mirror
 * carries the origin's version, it does not mint its own.
 */
export function touchUpdatedAt(
  table: string,
  primaryKey: string | readonly string[]
): string {
  return `
CREATE TRIGGER ${table}_touch_updated_at
AFTER UPDATE ON ${table}
WHEN NEW.row_version = OLD.row_version
BEGIN
  UPDATE ${table}
     SET updated_at = CASE WHEN NEW.updated_at = OLD.updated_at
                           THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                           ELSE NEW.updated_at END,
         row_version = OLD.row_version + 1
   WHERE ${pkMatch(table, typeof primaryKey === "string" ? [primaryKey] : primaryKey)};
END;`;
}

function pkMatch(table: string, primaryKey: readonly string[]): string {
  if (primaryKey.length === 0)
    throw new Error(`${table}: a lifecycle trigger needs a primary key`);
  return primaryKey.map((column) => `${column} = NEW.${column}`).join(" AND ");
}
