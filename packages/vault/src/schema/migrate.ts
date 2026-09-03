import type { DatabaseSync } from "node:sqlite";

import { ACCESS_DDL, ACCESS_INSTALL_MEMORY_DDL } from "./access.js";
import { AGENT_DDL } from "./agent.js";
import { AUDIT_DDL } from "./audit.js";
import { SHARE_AUTHORITY_DDL } from "./authority.js";
import { BLOB_TRANSFER_DDL } from "./blob-transfer.js";
import { BLOB_DDL } from "./blob.js";
import { COMMONS_RESILIENCE_DDL } from "./commons-resilience.js";
import { CORE_DDL, LINK_ANCHOR_DDL, SHARE_ORIGIN_DDL } from "./core.js";
import {
  LOCKER_ADDRESS_DDL,
  LOCKER_ALIAS_DDL,
  LOCKER_AUTH_DDL,
  LOCKER_DDL,
  LOCKER_FIELD_DDL,
  LOCKER_PASSKEY_DDL,
} from "./domains-locker.js";
import { PEOPLE_DDL } from "./domains-people.js";
import { SCHEDULE_DDL } from "./domains-schedule.js";
import {
  SOCIAL_DDL,
  KNOWLEDGE_DDL,
  MEDIA_DDL,
} from "./domains-social-knowledge-media.js";
import { TALLY_DDL, TALLY_LINE_ITEM_DDL } from "./domains-tally.js";
import { ENRICH_DDL } from "./enrich.js";
import { ENTITY_REVISIONS_DDL } from "./entity-revisions.js";
import {
  CORE_ENTITY_DDL,
  ENTITY_PURGE_REVOKE_DDL,
  refreshEntityTriggers,
} from "./entity.js";
import { APP_EXT_DDL } from "./ext.js";
import { FTS_DDL, assertFtsSpecsRegistered } from "./fts.js";
import { LEDGER_DDL } from "./ledger.js";
import { RENAME_INBOX_NOTICE_DDL } from "./notifications.js";
import { OUTBOX_DDL } from "./outbox.js";
import { REPLICA_DDL } from "./replica.js";
import { SEED_DDL } from "./seed.js";
import { SHARE_COMMONS_DDL } from "./share-commons.js";
import { SYNC_CREDENTIAL_DDL, SYNC_DDL } from "./sync.js";
import { assertVaultRegistryLabels } from "./tables.js";
import { TIME_ORGANIZE_DDL } from "./time-organize.js";

export const ONTOLOGY_VERSION = "1.0";

export const VAULT_MIGRATIONS: readonly string[] = [
  [
    CORE_DDL,
    CORE_ENTITY_DDL,
    LINK_ANCHOR_DDL,
    SHARE_ORIGIN_DDL,
    ACCESS_DDL,
    ACCESS_INSTALL_MEMORY_DDL,
    SEED_DDL,
    APP_EXT_DDL,
    AGENT_DDL,
    AUDIT_DDL,
    SYNC_DDL,
    SYNC_CREDENTIAL_DDL,
    SCHEDULE_DDL,
    SOCIAL_DDL,
    KNOWLEDGE_DDL,
    MEDIA_DDL,
    PEOPLE_DDL,
    LOCKER_DDL,
    LOCKER_AUTH_DDL,
    LOCKER_ALIAS_DDL,
    LOCKER_FIELD_DDL,
    LOCKER_ADDRESS_DDL,
    TALLY_DDL,
    TALLY_LINE_ITEM_DDL,
    LOCKER_PASSKEY_DDL,
    ENTITY_REVISIONS_DDL,
    TIME_ORGANIZE_DDL,
    ENRICH_DDL,
    OUTBOX_DDL,
    REPLICA_DDL,
    FTS_DDL,
    BLOB_TRANSFER_DDL,
    BLOB_DDL,
    RENAME_INBOX_NOTICE_DDL,
    SHARE_COMMONS_DDL,
    COMMONS_RESILIENCE_DDL,
    SHARE_AUTHORITY_DDL,
    ENTITY_PURGE_REVOKE_DDL,
    LEDGER_DDL,
  ].join("\n"),
];

export function migrateVault(db: DatabaseSync): void {
  assertVaultRegistryLabels();
  assertFtsSpecsRegistered();
  migrate(db, VAULT_MIGRATIONS);
  refreshEntityTriggers(db);
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

export class VaultSchemaAheadError extends Error {
  constructor(
    readonly fileVersion: number,
    readonly knownVersion: number
  ) {
    super(
      `this vault was written by a newer version of Centraid (schema v${fileVersion}, this build understands v${knownVersion}) — refusing to open; upgrade the app instead`
    );
    this.name = "VaultSchemaAheadError";
  }
}

export function migrate(db: DatabaseSync, migrations: readonly string[]): void {
  let version = currentVersion(db);
  if (version > migrations.length) {
    throw new VaultSchemaAheadError(version, migrations.length);
  }
  while (version < migrations.length) {
    const ddl = migrations[version];
    if (ddl === undefined) break;
    db.exec("BEGIN");
    try {
      db.exec(ddl);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    version += 1;
  }
}

const MIGRATION_CURSOR_DDL = `
CREATE TABLE IF NOT EXISTS schema_batch_cursor (
  name       TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  processed  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;
`;

export const DEFAULT_MIGRATION_BATCH_SIZE = 500;

export interface BatchedRewrite {
  name: string;
  selectBatchSql: string;
  applySql: string;
}

export interface BatchedMigrationResult {
  processed: number;
  batches: number;
  done: boolean;
}

export function runBatchedMigration(
  db: DatabaseSync,
  rewrite: BatchedRewrite,
  options: { batchSize?: number; maxBatches?: number; now?: string } = {}
): BatchedMigrationResult {
  const batchSize = options.batchSize ?? DEFAULT_MIGRATION_BATCH_SIZE;
  if (batchSize <= 0) throw new Error("migration batch size must be > 0");
  const maxBatches = options.maxBatches ?? Number.POSITIVE_INFINITY;
  if (maxBatches <= 0) throw new Error("migration maxBatches must be > 0");
  db.exec(MIGRATION_CURSOR_DDL);

  const state = db
    .prepare(
      `SELECT cursor, done, processed FROM schema_batch_cursor WHERE name = :name`
    )
    .get({ name: rewrite.name }) as
    | { cursor: string; done: number; processed: number }
    | undefined;
  if (state?.done === 1) return { processed: 0, batches: 0, done: true };

  const select = db.prepare(rewrite.selectBatchSql);
  const apply = db.prepare(rewrite.applySql);
  const saveCursor = db.prepare(
    `INSERT INTO schema_batch_cursor (name, cursor, done, processed, updated_at)
     VALUES (:name, :cursor, :done, :processed, :updatedAt)
     ON CONFLICT(name) DO UPDATE SET
       cursor = excluded.cursor,
       done = excluded.done,
       processed = excluded.processed,
       updated_at = excluded.updated_at`
  );

  let cursor = state?.cursor ?? "";
  let totalProcessed = state?.processed ?? 0;
  let processed = 0;
  let batches = 0;
  let done = false;
  const updatedAt = options.now ?? new Date().toISOString();

  while (batches < maxBatches) {
    const keys = (
      select.all({ cursor, limit: batchSize }) as { key: string }[]
    ).map((row) => row.key);
    if (keys.length === 0) {
      done = true;
      db.exec("BEGIN IMMEDIATE");
      try {
        saveCursor.run({
          name: rewrite.name,
          cursor,
          done: 1,
          processed: totalProcessed,
          updatedAt,
        });
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
      break;
    }
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const key of keys) apply.run({ key });
      cursor = keys[keys.length - 1] as string;
      totalProcessed += keys.length;
      saveCursor.run({
        name: rewrite.name,
        cursor,
        done: 0,
        processed: totalProcessed,
        updatedAt,
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    processed += keys.length;
    batches += 1;
  }
  return { processed, batches, done };
}
