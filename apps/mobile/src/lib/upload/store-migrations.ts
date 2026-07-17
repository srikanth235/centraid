// Schema migrations for the durable upload queue (#419 M0.4).
//
// The queue is unreplicated source-of-truth: a migration that half-applies and
// then bricks every subsequent open would strand a photo that exists nowhere
// else yet (the same class of brick as the #406 vault-open bug). So every
// migration here obeys two rules:
//
//   1. It runs inside ONE transaction with the `user_version` bump, so a kill
//      mid-migration rolls back atomically — the next open re-runs it from the
//      prior version rather than finding a half-migrated schema.
//   2. It is idempotent anyway: each step checks the current shape (a column's
//      existence) before mutating, so even a bump that somehow landed without
//      its ALTER (e.g. a pre-transaction database from an older build) heals on
//      the next open instead of throwing "duplicate column name" forever.

import type { ReplicaSqliteDriver } from '@centraid/client/replica/native';

/** Bumped when the DDL changes. Each step from any prior version is idempotent. */
export const SCHEMA_VERSION = 4;

type Driver = Pick<ReplicaSqliteDriver, 'exec' | 'run' | 'all'>;

interface ColumnRow {
  name: string;
}

/** True when `table` already has `column` — the guard before every ALTER ADD. */
function hasColumn(driver: Driver, table: string, column: string): boolean {
  return driver
    .all<ColumnRow>(`SELECT name FROM pragma_table_info(${quote(table)})`)
    .some((row) => row.name === column);
}

function quote(literal: string): string {
  return `'${literal.replace(/'/g, "''")}'`;
}

/** Run `work` and the version bump atomically; roll back together on a kill. */
function inTransaction(driver: Driver, toVersion: number, work: () => void): void {
  driver.exec('BEGIN IMMEDIATE');
  try {
    work();
    driver.exec(`PRAGMA user_version = ${toVersion};`);
    driver.exec('COMMIT');
  } catch (error) {
    driver.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Bring an existing database from `version` up to {@link SCHEMA_VERSION},
 * applying one transactional step per version gap. `followupDdl` recreates the
 * v1 follow-up ledger in place without touching the byte ledger.
 */
export function migrateUploadSchema(driver: Driver, version: number, followupDdl: string): void {
  if (version < 1 || version >= SCHEMA_VERSION) return;

  if (version < 2) {
    // v1 → v2: add the follow-up ledger next to transfers already in flight.
    inTransaction(driver, 2, () => driver.exec(followupDdl));
  }

  if (version < 3) {
    // v2 → v3: stable intent id for payload-idempotent replica writes.
    inTransaction(driver, 3, () => {
      if (!hasColumn(driver, 'upload_followup', 'intent_id')) {
        driver.exec('ALTER TABLE upload_followup ADD COLUMN intent_id TEXT;');
      }
      driver.exec(
        `UPDATE upload_followup
           SET intent_id = 'upload-followup-' || followup_id
         WHERE intent_id IS NULL`,
      );
      driver.exec(
        'CREATE UNIQUE INDEX IF NOT EXISTS upload_followup_intent ON upload_followup(intent_id);',
      );
    });
  }

  if (version < 4) {
    // v3 → v4: per-follow-up retry accounting and a terminal poison state, so
    // one un-replayable follow-up can be quarantined instead of starving the
    // rest (F4). NULL defaults keep the column add cheap on a large ledger.
    inTransaction(driver, 4, () => {
      if (!hasColumn(driver, 'upload_followup', 'attempts')) {
        driver.exec('ALTER TABLE upload_followup ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;');
      }
      if (!hasColumn(driver, 'upload_followup', 'poisoned_at')) {
        driver.exec('ALTER TABLE upload_followup ADD COLUMN poisoned_at TEXT;');
      }
      if (!hasColumn(driver, 'upload_followup', 'last_error')) {
        driver.exec('ALTER TABLE upload_followup ADD COLUMN last_error TEXT;');
      }
    });
  }
}
