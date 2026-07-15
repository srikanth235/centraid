import { afterEach, expect, test } from 'vitest';
import { openVaultDb, type VaultDb } from '../db.js';
import { readReplicaChanges } from './change-log.js';
import { readReplicaRow, readReplicaRows, withReplicaSnapshot } from './snapshot.js';

let db: VaultDb | undefined;
afterEach(() => {
  db?.close();
  db = undefined;
});

test('replica row helpers structurally exclude sealed columns and defer large values', () => {
  db = openVaultDb();
  db.vault
    .prepare(
      `INSERT INTO locker_item (
         item_id, type, title, password, notes, created_at, updated_at
       ) VALUES ('login-1', 'login', 'Bank', 'ciphertext-must-never-leave',
                 'this note is deliberately oversized', 't', 't')`,
    )
    .run();

  const page = readReplicaRows(db.vault, 'locker.item', { maxValueBytes: 8 });
  expect(page.sealedColumns).toContain('password');
  expect(page.columns).not.toContain('password');
  expect(page.rows).toEqual([
    expect.objectContaining({
      rowId: 'login-1',
      values: expect.objectContaining({ item_id: 'login-1', title: 'Bank' }),
      deferredColumns: expect.arrayContaining(['notes']),
    }),
  ]);
  expect(page.rows[0]?.values).not.toHaveProperty('password');
  expect(page.rows[0]?.deferredColumns).not.toContain('password');
});

test('unmasked snapshot and lazy reads structurally exclude protocol credentials', () => {
  db = openVaultDb();
  db.vault
    .prepare(
      `INSERT INTO consent_app
         (app_id, name, display_name, signing_key, status, origin, risk_ceiling, installed_at)
       VALUES ('credential-app', 'credential-app', 'Credential app', 'signing-never-replicate',
               'active', 'installed', 'low', '2026-07-15T00:00:00.000Z')`,
    )
    .run();

  const snapshot = readReplicaRows(db.vault, 'consent.app');
  expect(snapshot.columns).not.toContain('signing_key');
  expect(snapshot.rows).toEqual([
    expect.objectContaining({
      rowId: 'credential-app',
      values: expect.objectContaining({ app_id: 'credential-app', name: 'credential-app' }),
    }),
  ]);
  expect(snapshot.rows[0]?.values).not.toHaveProperty('signing_key');
  expect(snapshot.rows[0]?.deferredColumns).not.toContain('signing_key');

  const lazy = readReplicaRow(db.vault, 'consent.app', 'credential-app');
  expect(lazy?.values).not.toHaveProperty('signing_key');
  expect(lazy?.deferredColumns).not.toContain('signing_key');
  expect(JSON.stringify({ snapshot, lazy })).not.toContain('signing-never-replicate');
});

test('changed rows can be fetched by log row id and deletes resolve absent', () => {
  db = openVaultDb();
  db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES ('scheme-1', 'urn:scheme-1', 'Kinds', '1')`,
    )
    .run();
  const change = readReplicaChanges(db.vault).changes[0];
  expect(change?.rowId).toBe('scheme-1');
  expect(readReplicaRow(db.vault, change?.entity ?? '', change?.rowId ?? '')).toMatchObject({
    rowId: 'scheme-1',
    values: expect.objectContaining({ title: 'Kinds' }),
  });

  db.vault.prepare(`DELETE FROM core_concept_scheme WHERE scheme_id = 'scheme-1'`).run();
  expect(readReplicaRow(db.vault, 'core.concept_scheme', 'scheme-1')).toBeUndefined();
});

test('snapshot reader returns rows pinned to the same reported watermark', () => {
  db = openVaultDb();
  db.vault
    .prepare(
      `INSERT INTO core_concept_scheme (scheme_id, uri, title, version)
       VALUES ('scheme-1', 'urn:scheme-1', 'Kinds', '1')`,
    )
    .run();
  const snapshot = withReplicaSnapshot(db.vault, (reader) =>
    reader.readRows('core.concept_scheme'),
  );
  expect(snapshot.state.watermark.seq).toBe(1);
  expect(snapshot.value.rows.map((row) => row.rowId)).toEqual(['scheme-1']);
});

test('protocol intent rows are not exposed by the generic ontology snapshot helper', () => {
  db = openVaultDb();
  const vault = db.vault;
  expect(() => readReplicaRows(vault, 'replica.intent')).toThrow(/unknown replica entity/);
});
