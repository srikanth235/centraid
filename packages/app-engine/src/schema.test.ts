import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readAppSchema } from './schema.ts';

let workspace: string;
let dbFile: string;

beforeEach(async () => {
  workspace = path.join(os.tmpdir(), `centraid-schema-${crypto.randomBytes(6).toString('hex')}`);
  dbFile = path.join(workspace, 'data.sqlite');
  await fs.mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function seed(stmts: string[], userVersion = 0): void {
  const db = new DatabaseSync(dbFile);
  try {
    for (const s of stmts) db.exec(s);
    if (userVersion > 0) db.exec(`PRAGMA user_version = ${userVersion}`);
  } finally {
    db.close();
  }
}

test('fresh DB → schemaVersion 0, empty tables/indexes/views', () => {
  const schema = readAppSchema(dbFile);
  assert.deepEqual(schema, { schemaVersion: 0, tables: [], indexes: [], views: [] });
});

test('single table — columns + sql + user_version surfaced', () => {
  seed(
    [
      `CREATE TABLE todos (
        id INTEGER PRIMARY KEY,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        created_at TEXT
      )`,
    ],
    1,
  );

  const schema = readAppSchema(dbFile);
  assert.equal(schema.schemaVersion, 1);
  assert.equal(schema.tables.length, 1);

  const t = schema.tables[0]!;
  assert.equal(t.name, 'todos');
  assert.ok(t.sql && t.sql.startsWith('CREATE TABLE todos'));
  assert.deepEqual(
    t.columns.map((c) => c.name),
    ['id', 'text', 'done', 'created_at'],
  );

  const id = t.columns.find((c) => c.name === 'id')!;
  assert.equal(id.pk, true);
  assert.equal(id.type, 'INTEGER');

  const done = t.columns.find((c) => c.name === 'done')!;
  assert.equal(done.notnull, true);
  assert.equal(done.dflt_value, '0');

  const createdAt = t.columns.find((c) => c.name === 'created_at')!;
  assert.equal(createdAt.notnull, false);
  assert.equal(createdAt.dflt_value, null);
});

test('user index and view are surfaced; auto-indexes and sqlite_* are filtered', () => {
  seed([
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, tag TEXT UNIQUE)`,
    `CREATE INDEX idx_todos_tag ON todos(tag)`,
    `CREATE VIEW open_todos AS SELECT * FROM todos WHERE tag IS NOT NULL`,
  ]);

  const schema = readAppSchema(dbFile);

  // The UNIQUE on `tag` produces an auto-index that should NOT appear.
  assert.equal(schema.indexes.length, 1);
  assert.equal(schema.indexes[0]!.name, 'idx_todos_tag');
  assert.equal(schema.indexes[0]!.tbl_name, 'todos');

  assert.equal(schema.views.length, 1);
  assert.equal(schema.views[0]!.name, 'open_todos');
  assert.ok(schema.views[0]!.sql.startsWith('CREATE VIEW'));

  // No sqlite_* tables in the output.
  assert.ok(schema.tables.every((t) => !t.name.startsWith('sqlite_')));
});

test('table with quoted identifier (dash in name) round-trips', () => {
  seed([`CREATE TABLE "with-dash" (id INTEGER PRIMARY KEY, val TEXT)`]);
  const schema = readAppSchema(dbFile);
  const t = schema.tables.find((x) => x.name === 'with-dash');
  assert.ok(t, 'expected to find with-dash table');
  assert.deepEqual(
    t!.columns.map((c) => c.name),
    ['id', 'val'],
  );
});

test('multiple tables sorted alphabetically', () => {
  seed([
    `CREATE TABLE zebra (id INTEGER PRIMARY KEY)`,
    `CREATE TABLE alpha (id INTEGER PRIMARY KEY)`,
    `CREATE TABLE mu (id INTEGER PRIMARY KEY)`,
  ]);
  const schema = readAppSchema(dbFile);
  assert.deepEqual(
    schema.tables.map((t) => t.name),
    ['alpha', 'mu', 'zebra'],
  );
});
