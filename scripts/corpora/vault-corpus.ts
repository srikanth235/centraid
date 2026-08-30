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
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { JOURNAL_MIGRATIONS, VAULT_MIGRATIONS, migrate } from "@centraid/vault";

import { registerContentTextFn } from "../../packages/vault/src/schema/fts.js";

/** Number of vault schema epochs the ladder defines today (`user_version` 1..N). */
export const VAULT_LADDER_LENGTH = VAULT_MIGRATIONS.length;

/** Production vaults open at 8192 (`packages/vault/src/db.ts#openFile`); mirror it. */
const PAGE_SIZE = 8192;

/**
 * The census a fully-seeded pair must show — the semantic invariant both lanes
 * assert.
 *
 * IT COUNTS CONCEPTS, NOT TABLES (#883 rungs six and seven). Four of these are
 * spine rows that live in one table at every epoch. The last two are answers
 * whose STORE moves as the ladder climbs: an authority answer is a `share_grant`
 * row below rung six and a `share_authority` row above it, and a way to reach a
 * party is a `core_party_identifier` row below rung seven and a
 * `social_contact_channel` row above it. Counting the table would make the
 * invariant "the census survives the migration" untestable across exactly the
 * rungs that move data; counting the concept, over whichever stores the file's
 * schema has, is what makes a lossy fold fail here.
 */
export interface VaultCensus {
  party: number;
  content: number;
  media: number;
  receipt: number;
  /** Authority answers: `share_grant` below rung six, `share_authority` above. */
  authority: number;
  /** Ways to reach a party: reachability identifiers below rung seven, contact channels above. */
  reach: number;
}

/** The deterministic seed's expected census. A change here is a corpus change. */
export const EXPECTED_CENSUS: VaultCensus = {
  party: 3,
  content: 2,
  media: 2,
  receipt: 2,
  authority: 3,
  reach: 2,
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

/**
 * Seed the deterministic vault rows in the BASELINE (rung-1) shape.
 *
 * Every row here is written against rung one's tables and nothing else, which
 * is what lets one seed serve every epoch: `buildEpochPair` seeds at rung one
 * and then walks the ladder to the member's epoch, so the rungs THEMSELVES
 * produce each epoch's shape. Rung six reads the `share_grant` rows below and
 * folds them into `share_authority`; rung seven reads the `tel`/`email`
 * identifiers and folds them into `social_contact_channel`. Seeding the landed
 * shape by hand at the later epochs would have made those two rungs run over
 * empty tables in the one lane whose job is to migrate real rows forward.
 */
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

  /*
   * The authority answers rung six folds (`schema/authority.ts`). One live
   * party grant with a ceiling, one live circle grant without, and one revoked
   * grant — history the fold must keep, not a row to skip. No `consent_device`
   * and no `enrich_consent` rows: the device leg of rung six mints its ids with
   * `randomblob`, and a corpus member has to be byte-reproducible.
   */
  const grant = db.prepare(
    `INSERT INTO share_grant
       (grant_id, audience_kind, audience_id, subject_type, subject_id,
        capability, granted_at, revoked_at, granted_by, max_size_bytes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'corpus-party-0', ?)`
  );
  grant.run(
    "corpus-grant-live-party",
    "party",
    "corpus-party-1",
    "core.content_item",
    "corpus-content-0",
    "view",
    FIXED_TS,
    null,
    4096
  );
  grant.run(
    "corpus-grant-live-circle",
    "circle",
    "corpus-circle-0",
    "media.asset",
    "corpus-media-0",
    "edit",
    FIXED_TS,
    null,
    null
  );
  grant.run(
    "corpus-grant-revoked",
    "party",
    "corpus-party-2",
    "core.content_item",
    "corpus-content-1",
    "view",
    FIXED_TS,
    REVOKED_TS,
    null
  );

  /*
   * The reachability claims rung seven folds (`schema/reconcile.ts`). One
   * `email` and one `tel`, so both normalization branches run; the email is the
   * party's primary, so the rung's preferred-channel pass has a flag to carry.
   */
  const identifier = db.prepare(
    `INSERT INTO core_party_identifier
       (identifier_id, party_id, scheme, value, label, is_primary, verified_at,
        valid_from, valid_to)
     VALUES (?, ?, ?, ?, NULL, ?, NULL, ?, NULL)`
  );
  identifier.run(
    "corpus-identifier-email",
    "corpus-party-1",
    "email",
    "Corpus.Person@example.test",
    1,
    FIXED_TS
  );
  identifier.run(
    "corpus-identifier-tel",
    "corpus-party-2",
    "tel",
    "+1 (555) 010-0100",
    0,
    FIXED_TS
  );
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

/**
 * The fields the product schema mints nondeterministically, pinned to
 * constants so a member is byte-reproducible. Both touch a THROWAWAY test
 * vault only — production vaults keep the real values.
 *
 *   - `replica_meta` is INSERTed by REPLICA_DDL with a random `epoch` UUID and
 *     `strftime('now')` timestamps (packages/vault/src/schema/replica.ts).
 *   - a channel the rung-seven fold wrote carries a WALL-CLOCK `updated_at`:
 *     the rung's preferred-channel pass is an UPDATE, and
 *     `touchUpdatedAt`'s trigger (schema/updated-at.ts) stamps `now` on any
 *     update that does not set the column itself. Writing an explicitly
 *     different value here does not re-fire it — the trigger's `WHEN
 *     NEW.updated_at = OLD.updated_at` guard is exactly what that is for.
 */
function canonicalizeVault(db: DatabaseSync): void {
  db.exec(
    `UPDATE replica_meta
       SET epoch = '00000000-0000-0000-0000-000000000000',
           epoch_started_at = '${FIXED_TS}',
           updated_at = '${FIXED_TS}'
     WHERE singleton = 1;
     UPDATE social_contact_channel
        SET updated_at = '${FIXED_TS}'
      WHERE updated_at <> '${FIXED_TS}';`
  );
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
 * ladder.
 *
 * SEED AT RUNG ONE, THEN CLIMB. The rows only touch baseline tables, and the
 * remaining rungs are walked OVER them — `migrate` resumes from the file's own
 * `user_version`, so `slice(0, epoch)` runs rungs two through `epoch` on a
 * populated file. That ordering is the whole point once rungs move data:
 * seeding after the walk would hand rung six an empty `share_grant` and rung
 * seven an empty identifier register, and the corpus would cover the two folds
 * by name only. WAL is TRUNCATE-checkpointed so the base files are WAL-quiet on
 * disk (docs/traps/wal-checkpoint.md).
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
    migrate(vault, VAULT_MIGRATIONS.slice(0, 1));
    migrate(journal, JOURNAL_MIGRATIONS);
    seedVault(vault);
    seedJournal(journal);
    migrate(vault, VAULT_MIGRATIONS.slice(0, epoch));
    canonicalizeVault(vault);
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
    const has = (db: DatabaseSync, table: string): boolean =>
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?")
        .get(table) !== undefined;
    /*
     * SUM OVER WHICHEVER STORES THE FILE HAS. A rung that moves rows retires
     * the old table in the same pass, so at most one side of each pair exists
     * at a time and the sum is the concept's count at every epoch — while a
     * fold that dropped a row, or double-counted one, moves the total.
     */
    const acrossStores = (
      db: DatabaseSync,
      sources: ReadonlyArray<{ table: string; where?: string }>
    ): number =>
      sources.reduce(
        (total, source) =>
          total +
          (has(db, source.table)
            ? (
                db
                  .prepare(
                    `SELECT count(*) AS c FROM ${source.table}${source.where ? ` WHERE ${source.where}` : ""}`
                  )
                  .get() as { c: number }
              ).c
            : 0),
        0
      );
    return {
      party: count(vault, "core_party"),
      content: count(vault, "core_content_item"),
      media: count(vault, "media_asset"),
      receipt: count(journal, "consent_receipt"),
      authority: acrossStores(vault, [
        { table: "share_grant" },
        { table: "share_authority" },
      ]),
      reach: acrossStores(vault, [
        {
          table: "core_party_identifier",
          where: "scheme IN ('tel','email')",
        },
        { table: "social_contact_channel" },
      ]),
    };
  } finally {
    vault.close();
    journal.close();
  }
}
