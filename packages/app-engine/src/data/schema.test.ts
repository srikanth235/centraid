import { afterEach, beforeEach, expect, test } from 'vitest';
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
  expect(schema).toEqual({ schemaVersion: 0, tables: [], indexes: [], views: [] });
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
  expect(schema.schemaVersion).toBe(1);
  expect(schema.tables.length).toBe(1);

  const t = schema.tables[0]!;
  expect(t.name).toBe('todos');
  expect(t.sql && t.sql.startsWith('CREATE TABLE todos')).toBeTruthy();
  expect(t.columns.map((c) => c.name)).toEqual(['id', 'text', 'done', 'created_at']);

  const id = t.columns.find((c) => c.name === 'id')!;
  expect(id.pk).toBe(true);
  expect(id.type).toBe('INTEGER');

  const done = t.columns.find((c) => c.name === 'done')!;
  expect(done.notnull).toBe(true);
  expect(done.dflt_value).toBe('0');

  const createdAt = t.columns.find((c) => c.name === 'created_at')!;
  expect(createdAt.notnull).toBe(false);
  expect(createdAt.dflt_value).toBe(null);
});

test('user index and view are surfaced; auto-indexes and sqlite_* are filtered', () => {
  seed([
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, tag TEXT UNIQUE)`,
    `CREATE INDEX idx_todos_tag ON todos(tag)`,
    `CREATE VIEW open_todos AS SELECT * FROM todos WHERE tag IS NOT NULL`,
  ]);

  const schema = readAppSchema(dbFile);

  // The UNIQUE on `tag` produces an auto-index that should NOT appear.
  expect(schema.indexes.length).toBe(1);
  expect(schema.indexes[0]!.name).toBe('idx_todos_tag');
  expect(schema.indexes[0]!.tbl_name).toBe('todos');

  expect(schema.views.length).toBe(1);
  expect(schema.views[0]!.name).toBe('open_todos');
  expect(schema.views[0]!.sql.startsWith('CREATE VIEW')).toBeTruthy();

  // No sqlite_* tables in the output.
  expect(schema.tables.every((t) => !t.name.startsWith('sqlite_'))).toBeTruthy();
});

test('table with quoted identifier (dash in name) round-trips', () => {
  seed([`CREATE TABLE "with-dash" (id INTEGER PRIMARY KEY, val TEXT)`]);
  const schema = readAppSchema(dbFile);
  const t = schema.tables.find((x) => x.name === 'with-dash');
  expect(t).toBeTruthy();
  expect(t!.columns.map((c) => c.name)).toEqual(['id', 'val']);
});

test('multiple tables sorted alphabetically', () => {
  seed([
    `CREATE TABLE zebra (id INTEGER PRIMARY KEY)`,
    `CREATE TABLE alpha (id INTEGER PRIMARY KEY)`,
    `CREATE TABLE mu (id INTEGER PRIMARY KEY)`,
  ]);
  const schema = readAppSchema(dbFile);
  expect(schema.tables.map((t) => t.name)).toEqual(['alpha', 'mu', 'zebra']);
});
