/*
 * Per-app settings reader.
 *
 * Each app may opt into per-instance customization by creating a table
 * named `__centraid_settings` in its `data.sqlite`:
 *
 *   CREATE TABLE __centraid_settings (
 *     key   TEXT PRIMARY KEY,
 *     value TEXT NOT NULL  -- JSON-encoded scalar / object
 *   );
 *
 * Apps own this table — they can read/write it through their own SQL
 * handlers like any other table. The runtime only ever reads it, and only
 * during `app-index` to bake the values into the served HTML.
 *
 * Contract:
 *   - Table is OPTIONAL. Missing table = empty settings, no error.
 *   - Keys MUST be plain strings; values are JSON-decoded on read.
 *   - The runtime treats per-app values as overrides on top of the
 *     gateway-wide user prefs.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export const APP_SETTINGS_TABLE = '__centraid_settings';

/**
 * Read every `(key, value)` row from an app's `__centraid_settings` table.
 * Returns an empty object if the file or table is missing, or if the
 * underlying sqlite open fails — this lookup is best-effort and must never
 * cause the app's index.html to fail to serve.
 */
export function readAppSettings(dataDbFile: string): Record<string, unknown> {
  if (!existsSync(dataDbFile)) return {};
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dataDbFile, { readOnly: true });
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(APP_SETTINGS_TABLE);
    if (!tableRow) return {};
    const rows = db.prepare(`SELECT key, value FROM ${APP_SETTINGS_TABLE}`).all() as Array<{
      key: string;
      value: string;
    }>;
    const out: Record<string, unknown> = {};
    for (const r of rows) {
      try {
        out[r.key] = JSON.parse(r.value) as unknown;
      } catch {
        /* skip malformed row */
      }
    }
    return out;
  } catch {
    return {};
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to do */
    }
  }
}
