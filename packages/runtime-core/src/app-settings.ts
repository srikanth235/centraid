/*
 * Per-app settings reader/writer.
 *
 * Each app's `data.sqlite` may contain a `__centraid_settings` table:
 *
 *   CREATE TABLE __centraid_settings (
 *     key   TEXT PRIMARY KEY,
 *     value TEXT NOT NULL  -- JSON-encoded scalar / object
 *   );
 *
 * The table is shared between two writers, partitioned by key prefix:
 *
 *   - **App-owned keys** (no reserved prefix): the app reads/writes
 *     these through its own SQL handlers, same as any other table.
 *     Used for per-instance customization the app exposes to the user.
 *     `readAppSettings` is the runtime's bulk reader, called during
 *     `app-index` to bake values into the served HTML.
 *
 *   - **Runtime-owned keys** (prefix `__`): the runtime writes these
 *     directly via `writeAppSetting`; apps treat them as read-only.
 *     Currently only `__automation.<name>.enabled` lives here —
 *     user-facing automation toggle state, source-of-truth for the
 *     enabled flag (the gateway's `automations` mirror table reads it
 *     during sync and treats its own `enabled` column as a derived
 *     projection). This lets the toggle survive publish (data.sqlite
 *     is at the persistent app root, outside `versions/`), keeps it
 *     in one place, and makes "delete the app" wipe its toggles
 *     atomically.
 *
 * Contract:
 *   - Table is OPTIONAL on read. Missing table = empty settings, no error.
 *   - On write, the table is created on demand.
 *   - Keys MUST be plain strings; values are JSON-encoded.
 *   - All operations are best-effort on read (never throw — a corrupt
 *     setting must not block the app from serving). Writes do throw on
 *     unexpected I/O errors so the caller can surface a failure to
 *     register/unregister.
 */

import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';

export const APP_SETTINGS_TABLE = '__centraid_settings';

/** Reserved key prefix for runtime-owned settings. Apps must not write these. */
export const RUNTIME_KEY_PREFIX = '__';

/** Build the reserved key the runtime uses to persist an automation's enable toggle. */
export function automationEnabledKey(name: string): string {
  return `__automation.${name}.enabled`;
}

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

/**
 * Read a single setting value. Returns `undefined` if the DB file,
 * table, or key is absent (or the row is malformed JSON). Best-effort
 * — never throws.
 */
export function readAppSetting(dataDbFile: string, key: string): unknown | undefined {
  if (!existsSync(dataDbFile)) return undefined;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dataDbFile, { readOnly: true });
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(APP_SETTINGS_TABLE);
    if (!tableRow) return undefined;
    const row = db.prepare(`SELECT value FROM ${APP_SETTINGS_TABLE} WHERE key = ?`).get(key) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    try {
      return JSON.parse(row.value) as unknown;
    } catch {
      return undefined;
    }
  } catch {
    return undefined;
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to do */
    }
  }
}

/**
 * Write a single setting value. Creates `__centraid_settings` if
 * missing. Throws on unexpected I/O errors (caller surfaces — this is
 * the toggle-failed path the user needs to see).
 *
 * Writers race-tolerant via SQLite's standard locking; intended for
 * low-frequency runtime-owned writes (toggle flips, automation
 * registrations). Hot per-request paths should still go through the
 * regular sql-ops write surface.
 */
export function writeAppSetting(dataDbFile: string, key: string, value: unknown): void {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dataDbFile);
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${APP_SETTINGS_TABLE} (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
    );
    db.prepare(
      `INSERT INTO ${APP_SETTINGS_TABLE} (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    ).run(key, JSON.stringify(value));
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to do */
    }
  }
}

/**
 * Delete a single setting key. No-op when the DB, table, or row is
 * absent. Best-effort — never throws.
 */
export function deleteAppSetting(dataDbFile: string, key: string): void {
  if (!existsSync(dataDbFile)) return;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dataDbFile);
    const tableRow = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(APP_SETTINGS_TABLE);
    if (!tableRow) return;
    db.prepare(`DELETE FROM ${APP_SETTINGS_TABLE} WHERE key = ?`).run(key);
  } catch {
    // Best-effort — settings deletion failures shouldn't surface.
  } finally {
    try {
      db?.close();
    } catch {
      /* nothing to do */
    }
  }
}
