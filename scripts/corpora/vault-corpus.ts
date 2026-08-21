/*
 * Deterministic vault/journal corpus builder — the shared generator behind two
 * archaeology lanes (umbrella #842, slice B3):
 *
 *   - `tests/quality/schema-migration-corpus.test.ts` (W1.5): stamps a seeded
 *     pair at each schema epoch, migrates it forward with today's `migrate.ts`,
 *     and asserts a doctor report + a semantic census survive.
 *   - `tests/quality/backup-archaeology.test.ts` (W1.4): seals a seeded pair
 *     through the real backup engine and restores it with today's code.
 *
 * Why a GENERATOR and not committed binary goldens: a schema-only migrated
 * `vault.db` is ~2.7 MB at page_size 4096 and ~5.3 MB at the production 8192 —
 * the latter is over the 5 MB repo-hygiene ceiling. Committing one golden per
 * epoch/format would bloat the tree and trip `large-files`. The corpus is
 * therefore a deterministic generator plus a small committed census manifest,
 * exactly the tradeoff the umbrella's risk note prefers.
 *
 * Determinism contract: fixed ids, fixed ISO timestamps, fixed content — NO
 * `Math.random`, NO `Date.now`. Regenerating any member twice is byte-identical
 * (proven by both lanes), so a census drift is a real defect, never noise.
 */

import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";

import {
  JOURNAL_MIGRATIONS,
  VAULT_MIGRATIONS,
  migrate,
} from "@centraid/vault";

import { registerContentTextFn } from "../../packages/vault/src/schema/fts.js";

/** Number of vault schema epochs the ladder defines today (`user_version` 1..N). */
export const VAULT_LADDER_LENGTH = VAULT_MIGRATIONS.length;

/** Number of journal schema epochs (the journal ladder is short and epoch-flat). */
export const JOURNAL_LADDER_LENGTH = JOURNAL_MIGRATIONS.length;

/** Production vaults open at 8192 (`packages/vault/src/db.ts#openFile`); mirror it. */
const PAGE_SIZE = 8192;

/** The census a fully-seeded pair must show — the semantic invariant both lanes assert. */
export interface VaultCensus {
  party: number;
  content: number;
  media: number;
  receipt: number;
}

/** The deterministic seed's expected census. A change here is a corpus change. */
export const EXPECTED_CENSUS: VaultCensus = {
  party: 3,
  content: 2,
  media: 2,
  receipt: 2,
};

const FIXED_TS = "2024-01-01T00:00:00.000Z";

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function openVaultHandle(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA page_size = ${PAGE_SIZE}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  // The FTS triggers the baseline installs call this app-defined function; a
  // handle that migrates the schema must carry it or the very first rung fails.
  registerContentTextFn(db);
  return db;
}

function openJournalHandle(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA page_size = ${PAGE_SIZE}`);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA journal_mode = WAL");
  return db;
}

/** Seed the deterministic vault rows. Only baseline (rung-1) tables — epoch-flat. */
function seedVault(db: DatabaseSync): void {
  db.exec("BEGIN");
  const party = db.prepare(
    "INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version) VALUES (?, 'person', ?, ?, ?, '1.4')"
  );
  for (let i = 0; i < EXPECTED_CENSUS.party; i += 1) {
    party.run(`corpus-party-${i}`, `Corpus person ${i}`, FIXED_TS, FIXED_TS);
  }
  const content = db.prepare(
    "INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, title, created_at) VALUES (?, 'image/jpeg', ?, ?, 4096, ?, ?)"
  );
  const media = db.prepare(
    "INSERT INTO media_asset (asset_id, content_id, kind, captured_at, favorite) VALUES (?, ?, 'photo', ?, 0)"
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
  db.exec("COMMIT");
}

/**
 * Seed deterministic journal receipts. Each references a seeded `core.party`
 * row (`object_type`/`object_id`), so the restored-pair G8 cross-check finds
 * every receipt's target present — `danglingReceipts` stays empty.
 */
function seedJournal(db: DatabaseSync): void {
  db.exec("BEGIN");
  const receipt = db.prepare(
    "INSERT INTO consent_receipt (receipt_id, grant_id, invocation_id, action, object_type, object_id, purpose_concept_id, decision, occurred_at, hash, detail_json) VALUES (?, NULL, NULL, 'read', 'core.party', ?, NULL, 'allow', ?, ?, NULL)"
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

export interface EpochPairPaths {
  dir: string;
  vaultFile: string;
  journalFile: string;
}

function pairPaths(dir: string): EpochPairPaths {
  return {
    dir,
    vaultFile: path.join(dir, "vault.db"),
    journalFile: path.join(dir, "journal.db"),
  };
}

/**
 * Build a seeded vault/journal pair whose vault is migrated to EXACTLY `epoch`
 * (`user_version === epoch`, `1..VAULT_LADDER_LENGTH`) and journal to its full
 * ladder. The rows only touch baseline tables, so the same seed is valid at
 * every epoch — which is what lets the forward-migration lane assert the census
 * is preserved across the rungs. WAL is TRUNCATE-checkpointed so the base files
 * are WAL-quiet on disk (docs/traps/wal-checkpoint.md).
 */
export function buildEpochPair(dir: string, epoch: number): EpochPairPaths {
  if (!Number.isInteger(epoch) || epoch < 1 || epoch > VAULT_LADDER_LENGTH) {
    throw new Error(
      `buildEpochPair: epoch ${epoch} out of range 1..${VAULT_LADDER_LENGTH}`
    );
  }
  const paths = pairPaths(dir);
  const vault = openVaultHandle(paths.vaultFile);
  const journal = openJournalHandle(paths.journalFile);
  try {
    migrate(vault, VAULT_MIGRATIONS.slice(0, epoch));
    migrate(journal, JOURNAL_MIGRATIONS);
    seedVault(vault);
    seedJournal(journal);
    vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    journal.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    vault.close();
    journal.close();
  }
  return paths;
}

/** Build a fully-migrated, fully-seeded pair (the HEAD epoch). */
export function buildHeadPair(dir: string): EpochPairPaths {
  return buildEpochPair(dir, VAULT_LADDER_LENGTH);
}

/** Migrate an on-disk pair forward with today's ladder. Returns the stamped versions. */
export function migratePairForward(paths: EpochPairPaths): {
  vaultUserVersion: number;
  journalUserVersion: number;
} {
  const vault = openVaultHandle(paths.vaultFile);
  const journal = openJournalHandle(paths.journalFile);
  try {
    migrate(vault, VAULT_MIGRATIONS);
    migrate(journal, JOURNAL_MIGRATIONS);
    vault.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    journal.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    return {
      vaultUserVersion: userVersion(vault),
      journalUserVersion: userVersion(journal),
    };
  } finally {
    vault.close();
    journal.close();
  }
}

/** Read `PRAGMA user_version` off an on-disk vault file. */
export function readVaultUserVersion(file: string): number {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return userVersion(db);
  } finally {
    db.close();
  }
}

function userVersion(db: DatabaseSync): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number })
    .user_version;
}

/** Semantic census over a restored/on-disk pair directory. */
export function censusPair(dir: string): VaultCensus {
  const paths = pairPaths(dir);
  const vault = new DatabaseSync(paths.vaultFile, { readOnly: true });
  const journal = new DatabaseSync(paths.journalFile, { readOnly: true });
  try {
    const count = (db: DatabaseSync, table: string): number =>
      (db.prepare(`SELECT count(*) AS c FROM ${table}`).get() as { c: number })
        .c;
    return {
      party: count(vault, "core_party"),
      content: count(vault, "core_content_item"),
      media: count(vault, "media_asset"),
      receipt: count(journal, "consent_receipt"),
    };
  } finally {
    vault.close();
    journal.close();
  }
}
