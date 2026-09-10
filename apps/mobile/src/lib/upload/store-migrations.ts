// Upload queue schema migrations (#419.4): ONE transaction per step with the
// version bump; every step idempotent.

import type { UploadSqliteDriver } from "../replica/expo-sqlite-driver";

/** Bumped when the DDL changes. */
export const SCHEMA_VERSION = 6;

type Driver = Pick<UploadSqliteDriver, "exec" | "run" | "all">;

interface ColumnRow {
  name: string;
}

/** Guard before every ALTER ADD. */
function hasColumn(driver: Driver, table: string, column: string): boolean {
  return driver
    .all<ColumnRow>(`SELECT name FROM pragma_table_info(${quote(table)})`)
    .some((row) => row.name === column);
}

function quote(literal: string): string {
  return `'${literal.replace(/'/gu, "''")}'`;
}

/** Run `work` + the version bump atomically. */
function inTransaction(
  driver: Driver,
  toVersion: number,
  work: () => void
): void {
  driver.exec("BEGIN IMMEDIATE");
  try {
    work();
    driver.exec(`PRAGMA user_version = ${toVersion};`);
    driver.exec("COMMIT");
  } catch (error) {
    driver.exec("ROLLBACK");
    throw error;
  }
}

export function migrateUploadSchema(
  driver: Driver,
  version: number,
  followupDdl: string
): void {
  if (version < 1 || version >= SCHEMA_VERSION) return;

  if (version < 2) {
    // v1 → v2: add the follow-up ledger.
    inTransaction(driver, 2, () => driver.exec(followupDdl));
  }

  if (version < 3) {
    // v2 → v3: stable intent_id for payload-idempotent writes.
    inTransaction(driver, 3, () => {
      if (!hasColumn(driver, "upload_followup", "intent_id")) {
        driver.exec("ALTER TABLE upload_followup ADD COLUMN intent_id TEXT;");
      }
      driver.exec(
        `UPDATE upload_followup
           SET intent_id = 'upload-followup-' || followup_id
         WHERE intent_id IS NULL`
      );
      driver.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS upload_followup_intent ON upload_followup(intent_id);"
      );
    });
  }

  if (version < 4) {
    // v3 → v4: retry accounting + poison state (F4).
    inTransaction(driver, 4, () => {
      if (!hasColumn(driver, "upload_followup", "attempts")) {
        driver.exec(
          "ALTER TABLE upload_followup ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;"
        );
      }
      if (!hasColumn(driver, "upload_followup", "poisoned_at")) {
        driver.exec("ALTER TABLE upload_followup ADD COLUMN poisoned_at TEXT;");
      }
      if (!hasColumn(driver, "upload_followup", "last_error")) {
        driver.exec("ALTER TABLE upload_followup ADD COLUMN last_error TEXT;");
      }
    });
  }

  // v6's rebuild SELECTs `target_vault_id`, so v5 runs first even though the
  // rebuild would otherwise subsume it.
  legacyTargetVaultColumn(driver, version);

  if (version < 6) {
    migrateToPerVaultDedupe(driver);
  }
}

/**
 * v5 → v6: the dedupe key is (sha256, target_vault_id), not sha256 (#1014, P3).
 *
 * A phone that holds two vaults queued the SAME photograph for both and the
 * second enqueue silently returned the FIRST row — one upload, one vault, and
 * the member's other vault never got the picture. SQLite cannot drop an inline
 * column constraint, so the table is rebuilt without it and the real key
 * becomes an expression index over `COALESCE(target_vault_id, '')`: a plain
 * `UNIQUE (sha256, target_vault_id)` would treat every NULL as distinct and
 * let a legacy unassigned row duplicate itself.
 *
 * `edge_digest` (P22) and `settled_at` (P25) arrive in the same rebuild: both
 * are new columns on the same table and a second rebuild would cost a second
 * copy of a queue that can hold tens of thousands of rows.
 */
function migrateToPerVaultDedupe(driver: Driver): void {
  // `upload_followup.item_id` is `ON DELETE CASCADE`, so dropping the old
  // table would take every pending canonical write with it — bytes durable in
  // the CAS and no row ever written. `PRAGMA foreign_keys` is a no-op inside a
  // transaction, so it is set here and restored to whatever the caller had.
  const enforced =
    driver.all<{ foreign_keys: number }>("PRAGMA foreign_keys")[0]
      ?.foreign_keys ?? 0;
  if (enforced) driver.exec("PRAGMA foreign_keys=OFF;");
  try {
    rebuildItemTable(driver);
  } finally {
    if (enforced) driver.exec("PRAGMA foreign_keys=ON;");
  }
}

function rebuildItemTable(driver: Driver): void {
  inTransaction(driver, 6, () => {
    driver.exec(`
      CREATE TABLE IF NOT EXISTS upload_item_v6 (
        item_id TEXT PRIMARY KEY,
        sha256 TEXT NOT NULL,
        local_uri TEXT NOT NULL,
        target_vault_id TEXT,
        media_type TEXT,
        filename TEXT,
        plaintext_size INTEGER NOT NULL,
        sealed_size INTEGER NOT NULL,
        frame_count INTEGER NOT NULL,
        part_count INTEGER NOT NULL,
        state TEXT NOT NULL,
        session_id TEXT,
        created_order INTEGER NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        receipt_json TEXT,
        edge_digest TEXT,
        settled_at TEXT,
        dismissed_at TEXT,
        next_attempt_at TEXT
      );
      INSERT OR IGNORE INTO upload_item_v6(
        item_id, sha256, local_uri, target_vault_id, media_type, filename,
        plaintext_size, sealed_size, frame_count, part_count, state, session_id,
        created_order, attempts, last_error, receipt_json)
        SELECT item_id, sha256, local_uri, target_vault_id, media_type, filename,
               plaintext_size, sealed_size, frame_count, part_count, state,
               session_id, created_order, attempts, last_error, receipt_json
          FROM upload_item;
      DROP TABLE upload_item;
      ALTER TABLE upload_item_v6 RENAME TO upload_item;
      CREATE INDEX IF NOT EXISTS upload_item_state ON upload_item(state, created_order);
      CREATE UNIQUE INDEX IF NOT EXISTS upload_item_sha_vault
        ON upload_item(sha256, COALESCE(target_vault_id, ''));
    `);
  });
}

function legacyTargetVaultColumn(driver: Driver, version: number): void {
  if (version < 5) {
    // v4 → v5: durable target_vault_id.
    inTransaction(driver, 5, () => {
      if (!hasColumn(driver, "upload_item", "target_vault_id")) {
        driver.exec("ALTER TABLE upload_item ADD COLUMN target_vault_id TEXT;");
      }
    });
  }
}
