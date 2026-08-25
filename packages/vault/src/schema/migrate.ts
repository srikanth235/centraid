// The schema ladder for vault.db and journal.db. Rung one is the baseline,
// composed of every owner table's DDL in dependency order, including what
// #726's forward rename and #731's Commons control plane used to
// ship as separate rungs. Rung two (#821) is the first genuine upgrade
// rung: relaxing a CHECK in the baseline text reaches new files only, so
// vaults already stamped v1 need a vault-preserving rebuild to get there.
// Rung three (#825) adds the grant plane's tables and restates live
// commons grants into them; it is written `IF NOT EXISTS` + backfill so a
// fresh file, which got the tables from the baseline, walks it as a no-op.
// `migrate()` applies rungs transactionally and stamps `PRAGMA user_version`,
// and that version number is load-bearing beyond this file: it is the
// downgrade guard
// (`VaultSchemaAheadError`, thrown when a file's version exceeds what this
// build's ladder knows how to reach) and it is the "schema version this
// build understands" reported by the gateway's backup/recovery provenance
// (`packages/server/src/backup/backup-service.ts`,
// `packages/server/src/backup/recover-internals.ts` read
// `VAULT_MIGRATIONS.length`). A fresh file walks EVERY rung (rung two is a
// faithful re-creation on a table that already has the relaxed CHECK; rung
// three creates tables the baseline already made and backfills from an empty
// commons plane), so the two paths land on the same shape and version.

import type { DatabaseSync } from "node:sqlite";

import { AGENT_DDL } from "./agent.js";
import { BLOB_TRANSFER_DDL } from "./blob-transfer.js";
import { BLOB_DDL } from "./blob.js";
import { COMMONS_RESILIENCE_DDL } from "./commons-resilience.js";
import { CONSENT_DDL, CONSENT_INSTALL_MEMORY_DDL } from "./consent.js";
import {
  CORE_DDL,
  LINK_ANCHOR_DDL,
  SHARE_ORIGIN_ATTRIBUTION_DDL,
  SHARE_ORIGIN_DDL,
} from "./core.js";
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
import {
  PEOPLE_DDL,
  PEOPLE_PROFILE_CADENCE_FLOOR_DDL,
  PEOPLE_PROFILE_LIFECYCLE_DDL,
} from "./domains-people.js";
import {
  SOCIAL_DDL,
  KNOWLEDGE_DDL,
  MEDIA_DDL,
} from "./domains-social-knowledge-media.js";
import { TALLY_DDL, TALLY_RECEIPT_DDL } from "./domains-tally.js";
import { ENRICH_DDL } from "./enrich.js";
import { ENTITY_REVISIONS_DDL } from "./entity-revisions.js";
import { APP_EXT_DDL } from "./ext.js";
import { FTS_DDL } from "./fts.js";
import { JOURNAL_DDL } from "./journal.js";
import { RENAME_INBOX_NOTICE_DDL } from "./notifications.js";
import { OUTBOX_DDL } from "./outbox.js";
import { REPLICA_DDL } from "./replica.js";
import { SEED_DDL } from "./seed.js";
import { SHARE_COMMONS_DDL } from "./share-commons.js";
import {
  SHARE_FULFILLMENT_DELIVERY_MEMORY_DDL,
  SHARE_GRANT_BACKFILL_DDL,
  SHARE_GRANT_DDL,
} from "./share-grant.js";
import { SYNC_CREDENTIAL_DDL, SYNC_DDL } from "./sync.js";
import { TIME_ORGANIZE_DDL } from "./time-organize.js";

/**
 * Ontology contract version stamped on rows (rule R07). Bumped to 1.4 for
 * #450's canonical People consolidation, target-pair convention, and
 * cross-table invariant guards.
 */
export const ONTOLOGY_VERSION = "1.4";

// Composition order is dependency order:
//   - CORE first (everything references the spine), anchors ride with it;
//   - SHARE_ORIGIN_DDL then its forward rename (shared_by_member -> shared_by,
//     ex-#726 rung two) run back to back: SQLite's ALTER TABLE RENAME
//     COLUMN rewrites the stored sqlite_schema `sql` text in place, so a fresh
//     database ends up with a `core_share_origin` whose column has always
//     been `shared_by` — composing the two here (rather than hand-editing the
//     CREATE TABLE to skip the rename) keeps this file mechanism-only and
//     leaves the DDL modules untouched;
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
//     document's row), overriding the generated triggers by name;
//   - the Commons control plane (ex-#731 rung three) and, composed with
//     it, the local-only resilience/instrumentation tables that hang off it:
//     steward-contact state, this device's own link evidence, and recovery
//     lineage. `SHARE_COMMONS_DDL` alters `social_circle_member` (added by
//     SOCIAL_DDL above) so it must run after the domains.
export const VAULT_MIGRATIONS: readonly string[] = [
  [
    CORE_DDL,
    LINK_ANCHOR_DDL,
    SHARE_ORIGIN_DDL,
    SHARE_ORIGIN_ATTRIBUTION_DDL,
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
    PEOPLE_PROFILE_LIFECYCLE_DDL,
    LOCKER_DDL,
    LOCKER_AUTH_DDL,
    LOCKER_ALIAS_DDL,
    TALLY_DDL,
    TALLY_RECEIPT_DDL,
    ENTITY_REVISIONS_DDL,
    TIME_ORGANIZE_DDL,
    ENRICH_DDL,
    OUTBOX_DDL,
    REPLICA_DDL,
    FTS_DDL,
    BLOB_TRANSFER_DDL,
    BLOB_DDL,
    // Notifications is a rebuildable projection; its pre-release rename is
    // part of the composed base rather than a compatibility rung.
    RENAME_INBOX_NOTICE_DDL,
    SHARE_COMMONS_DDL,
    COMMONS_RESILIENCE_DDL,
    // The grant plane (#825) after the commons plane it is restated
    // from: `granted_by` references `core_party`, and rung three's backfill
    // reads `share_circle_grant` and the roster.
    SHARE_GRANT_DDL,
  ].join("\n"),
  // Rung two (#821): the vault-preserving people_profile rebuild that
  // carries the relaxed `cadence_days >= 0` CHECK to files created before it.
  // See `PEOPLE_PROFILE_CADENCE_FLOOR_DDL` for why a rebuild, and for how the
  // rung handles foreign keys inside the runner's transaction.
  PEOPLE_PROFILE_CADENCE_FLOOR_DDL,
  // Rung three (#825): the grant plane reaches files stamped before it.
  // The DDL is `IF NOT EXISTS` throughout, so a fresh file — which already got
  // the tables from the baseline above — walks this rung as a no-op create
  // plus a backfill that selects from an empty `share_circle_grant`, and the
  // two paths land on the same shape and version.
  SHARE_GRANT_BACKFILL_DDL,
  // Rung four (#846): `share_fulfillment.delivered_at`, the durable
  // memory of delivery that revocation reads instead of inferring it from the
  // live `state`. A table rebuild rather than an ADD COLUMN so the rung is
  // also a faithful no-op on a fresh file that got the column from the
  // baseline; see the DDL for the backfill and foreign-key reasoning.
  SHARE_FULFILLMENT_DELIVERY_MEMORY_DDL,
];

export const JOURNAL_MIGRATIONS: readonly string[] = [JOURNAL_DDL];

/** Apply the current pre-release vault schema. */
export function migrateVault(db: DatabaseSync): void {
  migrate(db, VAULT_MIGRATIONS);
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
 * Batched, resumable data rewrites (#659).
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
