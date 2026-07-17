import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, test } from 'vitest';
import { openVaultDb } from '../db.js';
import {
  JOURNAL_MIGRATIONS,
  migrate,
  ONTOLOGY_VERSION,
  VAULT_MIGRATIONS,
  VaultSchemaAheadError,
} from './migrate.js';
import { listVaultEntities, resolveEntity } from './tables.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'vault-migrate-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function userVersionOf(file: string): number {
  const raw = new DatabaseSync(file);
  const row = raw.prepare('PRAGMA user_version').get() as { user_version: number };
  raw.close();
  return row.user_version;
}

test('ontology contract version stamps 1.3 (issue #352: core_document + revises lineage)', () => {
  expect(ONTOLOGY_VERSION).toBe('1.3');
});

test('migrations create every table in the registry, in both files', () => {
  const db = openVaultDb();
  const names = (dbFile: typeof db.vault) =>
    new Set(
      (
        dbFile
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
          .all() as {
          name: string;
        }[]
      ).map((r) => r.name),
    );
  const vaultTables = names(db.vault);
  const journalTables = names(db.journal);
  for (const logical of listVaultEntities()) {
    const ref = resolveEntity(logical);
    expect(ref, logical).toBeDefined();
    expect(vaultTables.has(ref?.physical ?? ''), logical).toBe(true);
  }
  for (const logical of [
    'consent.receipt',
    'consent.provenance',
    'agent.command_invocation',
    'agent.evidence',
  ]) {
    const ref = resolveEntity(logical);
    expect(ref?.file).toBe('journal');
    expect(journalTables.has(ref?.physical ?? ''), logical).toBe(true);
  }
  db.close();
});

test('migrations are idempotent via user_version', () => {
  const db = openVaultDb();
  // openVaultDb already migrated; a second migrate run must be a no-op —
  // exercised by reopening the same in-memory handle path being impossible,
  // so assert user_version advanced exactly once per rung.
  const version = db.vault.prepare('PRAGMA user_version').get() as { user_version: number };
  expect(version.user_version).toBe(VAULT_MIGRATIONS.length);
  db.close();
});

test('the orphan-grace tombstone table exists on a fresh vault (issue #439 R4)', () => {
  const db = openVaultDb();
  // `blob_orphan` is plumbing (like blob_replica/blob_access), not a registered
  // logical entity, so the registry sweep above cannot cover it — assert directly.
  const row = db.vault
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='blob_orphan'`)
    .get() as { name: string } | undefined;
  expect(row?.name).toBe('blob_orphan');
  // first_orphaned_at must be present; a valid row round-trips as INTEGER ms.
  db.vault
    .prepare(`INSERT INTO blob_orphan (sha256, first_orphaned_at) VALUES (?, ?)`)
    .run('a'.repeat(64), 1700000000000);
  const stamp = db.vault
    .prepare(`SELECT first_orphaned_at FROM blob_orphan WHERE sha256 = ?`)
    .get('a'.repeat(64)) as { first_orphaned_at: number };
  expect(stamp.first_orphaned_at).toBe(1700000000000);
  db.close();
});

test('STRICT + CHECK constraints hold: bad enum and negative byte_size rejected', () => {
  const db = openVaultDb();
  expect(() =>
    db.vault
      .prepare(
        `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
         VALUES ('p1', 'alien', 'X', 't', 't', '1.1')`,
      )
      .run(),
  ).toThrow(/CHECK/);
  expect(() =>
    db.vault
      .prepare(
        `INSERT INTO core_content_item (content_id, media_type, content_uri, sha256, byte_size, created_at)
         VALUES ('c1', 'text/plain', 'file:///x', 'abc', -1, 't')`,
      )
      .run(),
  ).toThrow(/CHECK/);
  db.close();
});

test("extend-don't-fork: extension FK uniqueness prevents two extensions of one core row", () => {
  const db = openVaultDb();
  const now = new Date().toISOString();
  db.vault
    .prepare(
      `INSERT INTO core_party (party_id, kind, display_name, created_at, updated_at, ontology_version)
       VALUES ('p1', 'person', 'Owner', ?, ?, '1.1')`,
    )
    .run(now, now);
  db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version) VALUES ('s1', 'urn:x', 'Kinds', '1')`,
    )
    .run();
  db.vault
    .prepare(
      `INSERT INTO core_concept (concept_id, scheme_id, notation, pref_label) VALUES ('k1', 's1', 'run', 'Run')`,
    )
    .run();
  db.vault
    .prepare(
      `INSERT INTO core_activity (activity_id, actor_party_id, kind_concept_id, started_at, created_at)
       VALUES ('a1', 'p1', 'k1', ?, ?)`,
    )
    .run(now, now);
  db.vault
    .prepare(
      `INSERT INTO health_workout (workout_id, activity_id, sport_concept_id) VALUES ('w1', 'a1', 'k1')`,
    )
    .run();
  expect(() =>
    db.vault
      .prepare(
        `INSERT INTO health_workout (workout_id, activity_id, sport_concept_id) VALUES ('w2', 'a1', 'k1')`,
      )
      .run(),
  ).toThrow(/UNIQUE/);
  db.close();
});

// These two tests exercise migrate() generically against JOURNAL_MIGRATIONS
// rather than VAULT_MIGRATIONS: the vault DDL's FTS triggers call a custom
// SQL function (vault_content_text) that only openVaultDb registers, so a
// bare DatabaseSync can't run VAULT_MIGRATIONS directly.
test('migrate: no-op guard does not fire for a fresh (behind) or already-migrated (equal) db', () => {
  const db = new DatabaseSync(':memory:');
  // behind: fresh file, version 0 < migrations.length
  expect(() => migrate(db, JOURNAL_MIGRATIONS)).not.toThrow();
  const afterFresh = db.prepare('PRAGMA user_version').get() as { user_version: number };
  expect(afterFresh.user_version).toBe(JOURNAL_MIGRATIONS.length);
  // equal: re-running against the now fully-migrated db is a no-op, not a throw
  expect(() => migrate(db, JOURNAL_MIGRATIONS)).not.toThrow();
  const afterReplay = db.prepare('PRAGMA user_version').get() as { user_version: number };
  expect(afterReplay.user_version).toBe(JOURNAL_MIGRATIONS.length);
  db.close();
});

test('migrate: user_version ahead of the ladder throws VaultSchemaAheadError with both versions', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, JOURNAL_MIGRATIONS);
  db.exec(`PRAGMA user_version = ${JOURNAL_MIGRATIONS.length + 3}`);
  let caught: unknown;
  try {
    migrate(db, JOURNAL_MIGRATIONS);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(VaultSchemaAheadError);
  const err = caught as VaultSchemaAheadError;
  expect(err.fileVersion).toBe(JOURNAL_MIGRATIONS.length + 3);
  expect(err.knownVersion).toBe(JOURNAL_MIGRATIONS.length);
  expect(err.message).toMatch(/newer version of Centraid/);
  db.close();
});

test('migrate: the guard also applies to journal.db migrations, not just vault.db', () => {
  const db = new DatabaseSync(':memory:');
  migrate(db, JOURNAL_MIGRATIONS);
  db.exec(`PRAGMA user_version = ${JOURNAL_MIGRATIONS.length + 1}`);
  expect(() => migrate(db, JOURNAL_MIGRATIONS)).toThrow(VaultSchemaAheadError);
  db.close();
});

test('downgrade guard end-to-end: openVaultDb refuses a file whose schema is ahead, and leaves it untouched', () => {
  const dir = tempDir();
  const first = openVaultDb({ dir });
  first.close();

  const vaultFile = path.join(dir, 'vault.db');
  const bumped = VAULT_MIGRATIONS.length + 5;
  const raw = new DatabaseSync(vaultFile);
  raw.exec(`PRAGMA user_version = ${bumped}`);
  raw.close();
  expect(userVersionOf(vaultFile)).toBe(bumped);

  expect(() => openVaultDb({ dir })).toThrow(VaultSchemaAheadError);

  // The failed open must not have touched the file: the artificially bumped
  // version (and hence the rest of the schema) is exactly as it was left.
  expect(userVersionOf(vaultFile)).toBe(bumped);
});
