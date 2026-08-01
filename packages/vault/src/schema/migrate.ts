// The forward-only schema ladder for vault.db and journal.db. The first rung
// remains the v0 base composed in dependency order. Issue #630 is the point at
// which real owner data must survive blueprint schema work, so every later
// shape change is an ordered, replay-safe rung instead of editing the base.
// Tracked via PRAGMA user_version; migrate() applies each rung transactionally.

import type { DatabaseSync } from "node:sqlite";

import { AGENT_DDL } from "./agent.js";
import { BLOB_TRANSFER_DDL } from "./blob-transfer.js";
import { BLOB_DDL } from "./blob.js";
import { CONSENT_DDL, CONSENT_INSTALL_MEMORY_DDL } from "./consent.js";
import { CORE_DDL, LINK_ANCHOR_DDL, SHARE_ORIGIN_DDL } from "./core.js";
import {
  HEALTH_DDL,
  FINANCE_DDL,
  SCHEDULE_DDL,
} from "./domains-health-finance-schedule.js";
import { HOME_DDL, BUSINESS_DDL } from "./domains-home-business.js";
import {
  LOCKER_ALIAS_DDL,
  LOCKER_AUTH_DDL,
  LOCKER_DDL,
} from "./domains-locker.js";
import { PEOPLE_DDL, PEOPLE_PROFILE_LIFECYCLE_DDL } from "./domains-people.js";
import {
  SOCIAL_DDL,
  KNOWLEDGE_DDL,
  MEDIA_DDL,
} from "./domains-social-knowledge-media.js";
import { TALLY_DDL, TALLY_RECEIPT_DDL } from "./domains-tally.js";
import { DROP_PEOPLE_MERGE_DDL } from "./drop-people-merge.js";
import { ENRICH_DDL } from "./enrich.js";
import { ENTITY_REVISIONS_DDL } from "./entity-revisions.js";
import { APP_EXT_DDL } from "./ext.js";
import { FTS_DDL } from "./fts.js";
import { JOURNAL_DDL } from "./journal.js";
import {
  NOTIFICATIONS_NOTICE_DDL,
  RENAME_INBOX_NOTICE_DDL,
} from "./notifications.js";
import { OUTBOX_DDL } from "./outbox.js";
import { REPLICA_DDL } from "./replica.js";
import { SEED_DDL } from "./seed.js";
import { SYNC_CREDENTIAL_DDL, SYNC_DDL } from "./sync.js";
import { TIME_ORGANIZE_DDL } from "./time-organize.js";

/**
 * Ontology contract version stamped on rows (rule R07). Bumped to 1.4 for
 * issue #450's canonical People consolidation, target-pair convention, and
 * cross-table invariant guards.
 */
export const ONTOLOGY_VERSION = "1.4";

// Composition order is dependency order:
//   - CORE first (everything references the spine), anchors ride with it;
//   - the consent plane (apps, grants, install memory, the seed registry,
//     the ext-band registry) before anything that enrolls or scopes;
//   - the agent plane's model tables;
//   - the sync spine before the domains (locker's connection anchor FKs it),
//     with its credential/health sidecars;
//   - the domains (extensions hold FKs into core; locker's alias sidecar and
//     tally after the domains they decorate);
//   - the outbox after sync and social (items reference connections and
//     published messages);
//   - enrichment after media (the phash sidecar FKs the asset);
//   - FTS_DDL near-last: generated triggers read every base table's final
//     shape, and the backfill is a no-op on a fresh file;
//   - BLOB_DDL dead last: it re-creates the document's FTS sync with the
//     derivative-aware body expression (extracted text feeds the owning
//     document's row), overriding the generated triggers by name.
export const VAULT_MIGRATIONS: readonly string[] = [
  [
    CORE_DDL,
    LINK_ANCHOR_DDL,
    SHARE_ORIGIN_DDL,
    CONSENT_DDL,
    CONSENT_INSTALL_MEMORY_DDL,
    SEED_DDL,
    APP_EXT_DDL,
    AGENT_DDL,
    SYNC_DDL,
    SYNC_CREDENTIAL_DDL,
    HEALTH_DDL,
    FINANCE_DDL,
    SCHEDULE_DDL,
    SOCIAL_DDL,
    KNOWLEDGE_DDL,
    MEDIA_DDL,
    HOME_DDL,
    BUSINESS_DDL,
    PEOPLE_DDL,
    LOCKER_DDL,
    LOCKER_ALIAS_DDL,
    TALLY_DDL,
    ENRICH_DDL,
    OUTBOX_DDL,
    REPLICA_DDL,
    FTS_DDL,
    BLOB_TRANSFER_DDL,
    BLOB_DDL,
  ].join("\n"),
  LOCKER_AUTH_DDL,
  ENTITY_REVISIONS_DDL,
  PEOPLE_PROFILE_LIFECYCLE_DDL,
  TALLY_RECEIPT_DDL,
  TIME_ORGANIZE_DDL,
  // After soft people.merge_people was folded into core.merge_party (#630/#638),
  // drop the unused people_merge residual without rewriting the organize band.
  DROP_PEOPLE_MERGE_DDL,
  // Notifications is a projection: decisions stay canonical and only durable
  // notices gain a new table (#647).
  NOTIFICATIONS_NOTICE_DDL,
  // The surface rename Inbox → Notifications (#665) renamed the table with it.
  // v0 owes no data migration: the old table is dropped, not copied.
  RENAME_INBOX_NOTICE_DDL,
];

export const JOURNAL_MIGRATIONS: readonly string[] = [JOURNAL_DDL];

/**
 * Repair the #526 credential sidecar added while the v0 ladder was still
 * collapsed to one rung. Existing development vaults already stamped at
 * user_version=1 do not replay CREATE TABLE IF NOT EXISTS, so add the column
 * explicitly before broker queries can touch it.
 */
// COMPAT(sync-oauth-mode-v0): added 2026-07-23, drop when the supported vault floor postdates #526.
export function repairSyncCredentialOauthMode(db: DatabaseSync): void {
  const table = db
    .prepare(
      `SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'sync_connection_credential'`
    )
    .get();
  if (!table) return;
  const columns = db
    .prepare(`PRAGMA table_info('sync_connection_credential')`)
    .all() as {
    name: string;
  }[];
  if (columns.some((column) => column.name === "oauth_mode")) return;
  db.exec(
    `ALTER TABLE sync_connection_credential
       ADD COLUMN oauth_mode TEXT NOT NULL DEFAULT 'byo'
       CHECK (oauth_mode IN ('byo','assist'))`
  );
}

// COMPAT(anchor-scope-memory-v0): added 2026-07-25, drop when the supported vault floor postdates #541.
/** Preserve narrow revocation memory in dev vaults that already stamped v0. */
export function repairConsentScopeTombstoneShape(db: DatabaseSync): void {
  const table = db
    .prepare(
      `SELECT 1 AS present FROM sqlite_master
        WHERE type = 'table' AND name = 'consent_scope_tombstone'`
    )
    .get();
  if (!table) return;
  const columns = new Set(
    (
      db.prepare(`PRAGMA table_info('consent_scope_tombstone')`).all() as {
        name: string;
      }[]
    ).map((column) => column.name)
  );
  if (!columns.has("row_filter_json")) {
    db.exec(
      `ALTER TABLE consent_scope_tombstone
         ADD COLUMN row_filter_json TEXT
         CHECK (row_filter_json IS NULL OR json_valid(row_filter_json))`
    );
  }
  if (!columns.has("field_mask_json")) {
    db.exec(
      `ALTER TABLE consent_scope_tombstone
         ADD COLUMN field_mask_json TEXT
         CHECK (field_mask_json IS NULL OR json_valid(field_mask_json))`
    );
  }
}

/** Apply the vault schema and its replay-safe compatibility repairs together. */
export function migrateVault(db: DatabaseSync): void {
  migrate(db, VAULT_MIGRATIONS);
  repairSyncCredentialOauthMode(db);
  repairConsentScopeTombstoneShape(db);
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

/**
 * Thrown when a file's `PRAGMA user_version` is ahead of what this build's
 * migration ladder knows how to reach — a newer-software backup restored
 * onto older software, or the app itself downgraded. The old loop was
 * forward-only and would silently no-op in this case, leaving the gateway
 * to open (and write into) a schema shape it doesn't understand. Callers
 * must let this propagate; opening the file anyway risks silent corruption.
 */
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

/** Apply every migration past user_version, each in its own transaction. */
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

/*
 * Batched, resumable data rewrites (issue #659 L7).
 *
 * The ladder above is right for DDL: a rung is small, atomic, and its cost is
 * independent of how much is in the vault. It is exactly wrong for a rung
 * that has to REWRITE rows — a single transaction over a table with a
 * million rows blocks the whole vault for as long as it takes, and a crash
 * halfway through means starting over from the top on the next open, forever
 * if the rewrite cannot finish inside one window.
 *
 * This primitive is the alternative: the rewrite runs in bounded batches, each
 * batch commits with its own cursor, and a pass may stop at any batch boundary
 * and resume exactly where it stopped. A host can therefore run a few batches
 * per sweep instead of holding the vault hostage at startup.
 *
 * No shipped rung needs it yet; it exists so that the first one that does is
 * not tempted to write the single-transaction version. The cursor table is
 * created on demand rather than as a rung of its own so that adopting the
 * primitive is a code change, not a schema-version bump.
 */

const MIGRATION_CURSOR_DDL = `
CREATE TABLE IF NOT EXISTS schema_batch_cursor (
  name       TEXT PRIMARY KEY,
  cursor     TEXT NOT NULL,
  done       INTEGER NOT NULL DEFAULT 0 CHECK (done IN (0,1)),
  processed  INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;
`;

/** Rows one batch rewrites when the caller names no other size. */
export const DEFAULT_MIGRATION_BATCH_SIZE = 500;

export interface BatchedRewrite {
  /** Stable name. The resume cursor is stored under it — never reuse one. */
  name: string;
  /**
   * Selects the next keys to rewrite. Bound with `:cursor` (the last key of
   * the previous batch, `''` on the first run) and `:limit`; must return one
   * TEXT column aliased `key`, ordered ascending, and must select only keys
   * strictly greater than `:cursor`. Ordering by the key is what makes the
   * cursor a resume point rather than an offset.
   */
  selectBatchSql: string;
  /** Rewrites ONE row. Bound with `:key`. */
  applySql: string;
}

export interface BatchedMigrationResult {
  /** Rows rewritten by this call (not cumulative). */
  processed: number;
  /** Batches this call committed. */
  batches: number;
  /** `true` once a batch came back empty — the rewrite is complete. */
  done: boolean;
}

/**
 * Run up to `maxBatches` batches of a data-rewriting migration, committing
 * each batch with its cursor. Calling it again resumes from the last
 * committed cursor; calling it after completion is a no-op that costs one
 * indexed read of the cursor row.
 */
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
      // Latch completion in its own transaction so a crash before this point
      // simply repeats the (empty) probe rather than losing the cursor.
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
