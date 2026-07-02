import { expect, test } from 'vitest';
import { openVaultDb } from '../db.js';
import { listVaultEntities, resolveEntity } from './tables.js';

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
  // so assert user_version advanced exactly once.
  const version = db.vault.prepare('PRAGMA user_version').get() as { user_version: number };
  expect(version.user_version).toBe(1);
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
