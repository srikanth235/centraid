import { test, beforeEach, afterEach } from 'vitest';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { readTableRows, TableRowsError, TABLE_ROWS_MAX_LIMIT } from './table-rows.ts';

let workspace: string;
let dbFile: string;

beforeEach(async () => {
  workspace = path.join(
    os.tmpdir(),
    `centraid-table-rows-${crypto.randomBytes(6).toString('hex')}`,
  );
  dbFile = path.join(workspace, 'data.sqlite');
  await fs.mkdir(workspace, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

function seed(stmts: string[]): void {
  const db = new DatabaseSync(dbFile);
  try {
    for (const s of stmts) db.exec(s);
  } finally {
    db.close();
  }
}

test('returns columns + rows + totalCount for a populated table', () => {
  seed([
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0)`,
    `INSERT INTO todos (text, done) VALUES ('a', 0), ('b', 1), ('c', 0)`,
  ]);

  const r = readTableRows(dbFile, 'todos');
  assert.deepEqual(r.columns, ['id', 'text', 'done']);
  assert.equal(r.totalCount, 3);
  assert.equal(r.rows.length, 3);
  assert.equal(r.rows[0]!.text, 'a');
  assert.equal(r.rows[2]!.done, 0);
});

test('empty table → empty rows, totalCount 0, columns still surfaced', () => {
  seed([`CREATE TABLE empty (id INTEGER PRIMARY KEY, val TEXT)`]);

  const r = readTableRows(dbFile, 'empty');
  assert.deepEqual(r.columns, ['id', 'val']);
  assert.equal(r.totalCount, 0);
  assert.deepEqual(r.rows, []);
});

test('limit + offset paginate correctly', () => {
  seed([
    `CREATE TABLE nums (n INTEGER PRIMARY KEY)`,
    `INSERT INTO nums (n) VALUES ${Array.from({ length: 10 }, (_, i) => `(${i + 1})`).join(', ')}`,
  ]);

  const page1 = readTableRows(dbFile, 'nums', { limit: 4, offset: 0 });
  assert.equal(page1.totalCount, 10);
  assert.equal(page1.rows.length, 4);
  assert.equal(page1.rows[0]!.n, 1);
  assert.equal(page1.rows[3]!.n, 4);

  const page2 = readTableRows(dbFile, 'nums', { limit: 4, offset: 4 });
  assert.equal(page2.rows[0]!.n, 5);
  assert.equal(page2.rows[3]!.n, 8);

  const tail = readTableRows(dbFile, 'nums', { limit: 4, offset: 8 });
  assert.equal(tail.rows.length, 2);
  assert.equal(tail.rows[0]!.n, 9);
});

test('limit is clamped to the server cap', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = readTableRows(dbFile, 't', { limit: 100_000 });
  assert.equal(r.limit, TABLE_ROWS_MAX_LIMIT);
});

test('limit defaults to 50 when omitted', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = readTableRows(dbFile, 't');
  assert.equal(r.limit, 50);
});

test('negative or zero offset normalises to 0', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`, `INSERT INTO t (id) VALUES (1), (2)`]);

  const r = readTableRows(dbFile, 't', { offset: -50 });
  assert.equal(r.offset, 0);
  assert.equal(r.rows.length, 2);
});

test('unknown table → TableRowsError("unknown_table")', () => {
  seed([`CREATE TABLE only (id INTEGER PRIMARY KEY)`]);

  assert.throws(
    () => readTableRows(dbFile, 'ghost'),
    (err: unknown) => err instanceof TableRowsError && err.code === 'unknown_table',
  );
});

test('sqlite_* internal tables are not addressable', () => {
  seed([`CREATE TABLE keep (id INTEGER PRIMARY KEY)`]);

  assert.throws(
    () => readTableRows(dbFile, 'sqlite_master'),
    (err: unknown) => err instanceof TableRowsError && err.code === 'unknown_table',
  );
});

test('view rows are returned just like a table', () => {
  seed([
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, done INTEGER NOT NULL)`,
    `INSERT INTO todos (done) VALUES (0), (1), (0)`,
    `CREATE VIEW open_todos AS SELECT id FROM todos WHERE done = 0`,
  ]);

  const r = readTableRows(dbFile, 'open_todos');
  assert.equal(r.totalCount, 2);
  assert.equal(r.columns[0], 'id');
});

test('table name with quote → safely round-trips via quoted identifier', () => {
  seed([
    `CREATE TABLE "with""quote" (id INTEGER PRIMARY KEY, v TEXT)`,
    `INSERT INTO "with""quote" (v) VALUES ('ok')`,
  ]);

  const r = readTableRows(dbFile, 'with"quote');
  assert.equal(r.totalCount, 1);
  assert.equal(r.rows[0]!.v, 'ok');
});
