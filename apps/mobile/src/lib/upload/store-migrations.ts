// Upload queue schema migrations (#419.4): ONE transaction per step with the
// version bump; every step idempotent.

import type { ReplicaSqliteDriver } from "@centraid/client/replica/native";

/** Bumped when the DDL changes. */
export const SCHEMA_VERSION = 5;

type Driver = Pick<ReplicaSqliteDriver, "exec" | "run" | "all">;

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

  if (version < 5) {
    // v4 → v5: durable target_vault_id.
    inTransaction(driver, 5, () => {
      if (!hasColumn(driver, "upload_item", "target_vault_id")) {
        driver.exec("ALTER TABLE upload_item ADD COLUMN target_vault_id TEXT;");
      }
    });
  }
}
