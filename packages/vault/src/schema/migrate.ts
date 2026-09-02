// The schema for vault.db — ONE file, ONE baseline, no ladder.
//
// v0 has no vaults in the field, so there is nothing to walk forward from: a
// rung that reconstructs a shape the baseline can simply state is
// compatibility code for a compatibility problem nobody has. `VAULT_MIGRATIONS`
// therefore holds exactly one entry — every owner table's DDL in dependency
// order — and a fresh file lands on `PRAGMA user_version = 1`.
//
// That number stays load-bearing beyond this file: it is the downgrade guard
// (`VaultSchemaAheadError`) and the "schema version this build understands"
// the backup/recovery provenance reports from `VAULT_MIGRATIONS.length`. The
// first shipped release that must reach an existing file adds rung two — and
// the baseline text becomes history at that moment, not before.

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

/**
 * The ontology contract version — a FILE-AND-CONTRACT property, never a
 * per-row stamp (#916, ruling ONT-04).
 *
 * Two numbers answer two different questions and neither is the other:
 *   - `PRAGMA user_version` is the FILE's SHAPE. It is what the downgrade
 *     guard reads, and on a v0 file it is 1.
 *   - This constant is the CONTRACT the gateway serves. It lives on
 *     `agent_command.ontology_version`, and `gateway/execution.ts` refuses a
 *     command whose contract is not EQUAL to it.
 *
 * Rule R07 was read for four releases as "stamp every row"; two tables carried
 * the column, nothing checked the one on `core_party`, and a stamp two tables
 * carry is a vestige rather than a version scheme. The column is gone — the
 * version is a property of the file and of the contract, and asking a row what
 * ontology it belongs to has no answer worth storing.
 *
 * "1.0" is the v0 ontology as #916 closed it: health and finance out, the self
 * party, the lifecycle declaration, one polymorphic spelling, the entity
 * supertype, the access plane, and the audit and ledger bands in the one file.
 */
export const ONTOLOGY_VERSION = "1.0";

// Composition order is dependency order:
//   - CORE first (everything references the spine), and the entity supertype
//     with it: every ontology table carries a foreign key into `core_entity`;
//   - the access plane (apps, grants, install memory, the seed registry, the
//     ext-band registry) before anything that enrolls or scopes;
//   - the agent plane's model tables, then the AUDIT band it writes into —
//     `core_entity_revision` names an invocation, so the band precedes it;
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
//   - the Commons control plane and, composed with it, the local-only
//     resilience/instrumentation tables that hang off it. `SHARE_COMMONS_DDL`
//     alters `social_circle_member` (added by SOCIAL_DDL above) so it must run
//     after the domains;
//   - the LEDGER band last of the machinery: it is engine-owned store code
//     over vault-owned tables and nothing in the ontology references it.
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
    // Locker's remaining sidecars (#872), all FK'd to `locker_item` so they
    // follow it: custom fields and sections, extra addresses, and the passkey
    // slot. The durable item/password history is `core_entity_revision`
    // (#916, owner decision D2).
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
    // Notifications is a rebuildable projection; its pre-release rename is
    // part of the composed base rather than a compatibility rung.
    RENAME_INBOX_NOTICE_DDL,
    SHARE_COMMONS_DDL,
    COMMONS_RESILIENCE_DDL,
    // The authority plane's table before the trigger that revokes into it
    // (#916, E2).
    SHARE_AUTHORITY_DDL,
    // A trigger ON `core_entity` that writes to `share_authority` and
    // `share_circle_grant`, so both must exist (#916, E2).
    ENTITY_PURGE_REVOKE_DDL,
    LEDGER_DDL,
  ].join("\n"),
];

/**
 * Apply the current pre-release vault schema.
 *
 * THE REGISTRY IS CHECKED FIRST (#883). Both gates are memoised pure functions
 * of module state, so this costs one pass per process — and it is the moment
 * worth failing at: an unnamed entity, or an FTS spec over a table the
 * registry does not declare, is a defect in the build, not in the file.
 */
export function migrateVault(db: DatabaseSync): void {
  assertVaultRegistryLabels();
  assertFtsSpecsRegistered();
  migrate(db, VAULT_MIGRATIONS);
  // Registry-generated, like the replica's triggers and for the same reason:
  // an entity added to the catalog must reach the file without a rung, and no
  // DDL module should name a primary key by hand (#916). Cheap on a warm open
  // — it returns after two counts when the file already agrees with the
  // registry.
  refreshEntityTriggers(db);
}

function currentVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version: number;
  };
  return row.user_version;
}

/**
 * A file's `PRAGMA user_version` is ahead of what this build's ladder reaches:
 * a newer-software backup restored onto older software, or a downgrade.
 * Callers must let this propagate — opening the file anyway would write into a
 * schema shape this build does not understand.
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
 * The ladder above is right for DDL — small, atomic, cost independent of vault
 * size — and exactly wrong for a rung that REWRITES rows: one transaction over
 * a million rows holds the vault for its duration, and a crash restarts it
 * from the top, forever if it cannot finish inside one window. Here the
 * rewrite runs in bounded batches, each committing its own cursor, so a pass
 * may stop at any boundary and resume there.
 *
 * No shipped rung needs it yet; it exists so the first one that does is not
 * tempted to write the single-transaction version. The cursor table is created
 * on demand, so adopting the primitive is a code change, not a version bump.
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
   * Bound with `:cursor` (last key of the previous batch, `''` first run) and
   * `:limit`; returns one TEXT column aliased `key`, ascending, strictly
   * greater than `:cursor`. That ordering makes the cursor a resume point
   * rather than an offset.
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
 * Up to `maxBatches` batches, each committed with its cursor. A repeat call
 * resumes from the last committed cursor; after completion it is a no-op
 * costing one indexed read.
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
