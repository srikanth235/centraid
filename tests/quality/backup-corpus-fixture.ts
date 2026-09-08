/*
 * The deterministic vault the backup-format archaeology lane seals (#842 W1.4).
 *
 * ONE FILE (#916): the audit band lives in `vault.db` beside the life data, so
 * a corpus member is a single database and its census is read off one handle.
 * There is no schema ladder to walk — v0 composes the whole shape in the
 * baseline — so this builds HEAD and nothing else.
 *
 * Why a GENERATOR and not committed binary goldens: a schema-only migrated
 * `vault.db` is over the 5 MB repo-hygiene ceiling at the production page size,
 * so committing one per format would trip `large-files`. The corpus is a
 * deterministic generator plus a small committed census manifest.
 *
 * Determinism contract: fixed ids, fixed ISO timestamps, fixed content — NO
 * `Math.random`, NO `Date.now`. Building any member twice is byte-identical
 * (the lane proves it), so a census drift is a real defect, never noise.
 */

import { createHash } from "node:crypto";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { VAULT_MIGRATIONS, migrate } from "@centraid/vault";

import { refreshEntityTriggers } from "../../packages/vault/src/schema/entity.js";
import { registerContentTextFn } from "../../packages/vault/src/schema/fts.js";

/** Production vaults open at 8192 (`packages/vault/src/db.ts#openFile`); mirror it. */
const PAGE_SIZE = 8192;

/**
 * The census a seeded member must show — the semantic invariant the lane
 * asserts over the RESTORED plaintext. It counts life rows and the audit
 * band's receipts together, because the point of one file is that a restore
 * can never hand back one without the other.
 */
export interface VaultCensus {
  party: number;
  content: number;
  media: number;
  receipt: number;
  authority: number;
}

/** The deterministic seed's expected census. A change here is a corpus change. */
export const EXPECTED_CENSUS: VaultCensus = {
  party: 3,
  content: 2,
  media: 2,
  receipt: 2,
  authority: 3,
};

const FIXED_TS = "2024-01-01T00:00:00.000Z";
/** A second fixed instant, so a revoked row is distinguishable from a live one. */
const REVOKED_TS = "2024-06-01T00:00:00.000Z";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function openVaultHandle(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA page_size = ${PAGE_SIZE}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  // The FTS triggers the baseline installs call this app-defined function; a
  // handle that composes the schema must carry it or the very first statement
  // fails.
  registerContentTextFn(db);
  return db;
}

/** Life rows plus the audit band's receipts about them, all in one file. */
function seed(db: DatabaseSync): void {
  db.exec("BEGIN");
  const party = db.prepare(
    "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at) VALUES (?, 'person', ?, ?, ?)"
  );
  for (let i = 0; i < EXPECTED_CENSUS.party; i += 1) {
    party.run(`corpus-party-${i}`, `Corpus person ${i}`, FIXED_TS, FIXED_TS);
  }
  const content = db.prepare(
    "INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, title, created_at) VALUES (?, 'image/jpeg', ?, ?, 4096, ?, ?)"
  );
  const media = db.prepare(
    "INSERT INTO media_asset (asset_id, content_id, kind, captured_at) VALUES (?, ?, 'photo', ?)"
  );
  for (let i = 0; i < EXPECTED_CENSUS.content; i += 1) {
    const contentId = `corpus-content-${i}`;
    content.run(
      contentId,
      `file:///corpus/photo-${i}.jpg`,
      digest(contentId),
      `Corpus photo ${i}`,
      FIXED_TS
    );
    media.run(`corpus-media-${i}`, contentId, FIXED_TS);
  }

  /*
   * The answers the member gave: one live person answer, one live circle
   * answer, and one REVOKED answer — history a restore must bring back, not a
   * row to skip. `granted_by` is a seeded party, so the file stays FK-clean.
   */
  const authority = db.prepare(
    `INSERT INTO share_authority
       (authority_id, principal_kind, principal_id, subject_type, subject_id,
        verb, duration, decision, granted_at, granted_by, revoked_at, revoked_reason)
     VALUES (?, ?, ?, ?, ?, ?, 'standing', ?, ?, 'corpus-party-0', ?, NULL)`
  );
  authority.run(
    "corpus-authority-live-person",
    "person",
    "corpus-party-1",
    "core.content_item",
    "corpus-content-0",
    "view",
    "granted",
    FIXED_TS,
    null
  );
  authority.run(
    "corpus-authority-live-circle",
    "circle",
    "corpus-circle-0",
    "media.asset",
    "corpus-media-0",
    "edit",
    "granted",
    FIXED_TS,
    null
  );
  authority.run(
    "corpus-authority-revoked",
    "person",
    "corpus-party-2",
    "core.content_item",
    "corpus-content-1",
    "view",
    "granted",
    FIXED_TS,
    REVOKED_TS
  );

  /*
   * Receipts naming a seeded `core.party` row, so the restored-vault
   * cross-check finds every receipt's target present — `danglingReceipts`
   * stays empty and the check is not vacuous.
   */
  const receipt = db.prepare(
    "INSERT INTO access_receipt (receipt_id, authority_id, invocation_id, action, object_type, object_id, decision, occurred_at, hash, detail_json) VALUES (?, NULL, NULL, 'read', 'core.party', ?, 'allow', ?, ?, NULL)"
  );
  for (let i = 0; i < EXPECTED_CENSUS.receipt; i += 1) {
    receipt.run(
      `corpus-receipt-${i}`,
      `corpus-party-${i}`,
      FIXED_TS,
      digest(`corpus-receipt-${i}`)
    );
  }
  db.exec("COMMIT");
}

/**
 * The fields the product schema mints nondeterministically, pinned to
 * constants so a member is byte-reproducible. This touches a THROWAWAY test
 * vault only — production vaults keep the real values.
 *
 *   - `replica_meta` is INSERTed by REPLICA_DDL with a random `epoch` UUID and
 *     `strftime('now')` timestamps (packages/vault/src/schema/replica.ts).
 *   - every `updated_at` the schema defaults carries a WALL-CLOCK stamp
 *     (schema/updated-at.ts). Writing an explicitly different value here does
 *     not re-fire the touch trigger — its `WHEN NEW.updated_at = OLD.updated_at`
 *     guard is exactly what that is for.
 */
function canonicalize(db: DatabaseSync): void {
  db.exec(
    `UPDATE replica_meta
       SET epoch = '00000000-0000-0000-0000-000000000000',
           epoch_started_at = '${FIXED_TS}',
           updated_at = '${FIXED_TS}'
     WHERE singleton = 1;`
  );
  // Pin EVERY clock-stamped column the engine wrote for us, wherever it landed:
  // the entity-membership trigger stamps `core_entity`, the revision trigger
  // stamps `core_entity_revision`, and the touch trigger stamps `updated_at`.
  // A per-table list would rot the first time a rung adds a trigger; the column
  // NAMES are the contract (schema/updated-at.ts, schema/entity.ts).
  const stamped = new Set(["created_at", "updated_at", "recorded_at"]);
  const tables = db
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
    )
    .all() as { name: string }[];
  for (const { name } of tables) {
    const columns = (
      db.prepare(`PRAGMA table_info("${name}")`).all() as { name: string }[]
    )
      .map((column) => column.name)
      .filter((column) => stamped.has(column));
    for (const column of columns) {
      db.exec(
        `UPDATE "${name}" SET "${column}" = '${FIXED_TS}' WHERE "${column}" <> '${FIXED_TS}'`
      );
    }
  }
}

export interface CorpusPaths {
  dir: string;
  vaultFile: string;
}

/**
 * Build the seeded member at HEAD. WAL is TRUNCATE-checkpointed so the base
 * file is WAL-quiet on disk (docs/traps/wal-checkpoint.md) — a snapshot of a
 * file with uncheckpointed frames is not self-consistent.
 */
export function buildCorpusVault(dir: string): CorpusPaths {
  const vaultFile = path.join(dir, "vault.db");
  const db = openVaultHandle(vaultFile);
  try {
    migrate(db, VAULT_MIGRATIONS);
    refreshEntityTriggers(db);
    seed(db);
    canonicalize(db);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
  return { dir, vaultFile };
}

/** Semantic census over a restored/on-disk vault directory. */
export function censusVault(dir: string): VaultCensus {
  const db = new DatabaseSync(path.join(dir, "vault.db"), { readOnly: true });
  try {
    const count = (table: string): number =>
      (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number })
        .c;
    return {
      party: count("core_party"),
      content: count("core_content_item"),
      media: count("media_asset"),
      receipt: count("access_receipt"),
      authority: count("share_authority"),
    };
  } finally {
    db.close();
  }
}
