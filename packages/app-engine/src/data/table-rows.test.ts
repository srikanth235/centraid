import { test, beforeEach, afterEach, expect } from 'vitest';
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
  expect(r.columns).toEqual(['id', 'text', 'done']);
  expect(r.totalCount).toBe(3);
  expect(r.rows.length).toBe(3);
  expect(r.rows[0]!.text).toBe('a');
  expect(r.rows[2]!.done).toBe(0);
});

test('empty table → empty rows, totalCount 0, columns still surfaced', () => {
  seed([`CREATE TABLE empty (id INTEGER PRIMARY KEY, val TEXT)`]);

  const r = readTableRows(dbFile, 'empty');
  expect(r.columns).toEqual(['id', 'val']);
  expect(r.totalCount).toBe(0);
  expect(r.rows).toEqual([]);
});

test('limit + offset paginate correctly', () => {
  seed([
    `CREATE TABLE nums (n INTEGER PRIMARY KEY)`,
    `INSERT INTO nums (n) VALUES ${Array.from({ length: 10 }, (_, i) => `(${i + 1})`).join(', ')}`,
  ]);

  const page1 = readTableRows(dbFile, 'nums', { limit: 4, offset: 0 });
  expect(page1.totalCount).toBe(10);
  expect(page1.rows.length).toBe(4);
  expect(page1.rows[0]!.n).toBe(1);
  expect(page1.rows[3]!.n).toBe(4);

  const page2 = readTableRows(dbFile, 'nums', { limit: 4, offset: 4 });
  expect(page2.rows[0]!.n).toBe(5);
  expect(page2.rows[3]!.n).toBe(8);

  const tail = readTableRows(dbFile, 'nums', { limit: 4, offset: 8 });
  expect(tail.rows.length).toBe(2);
  expect(tail.rows[0]!.n).toBe(9);
});

test('limit is clamped to the server cap', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = readTableRows(dbFile, 't', { limit: 100_000 });
  expect(r.limit).toBe(TABLE_ROWS_MAX_LIMIT);
});

test('limit defaults to 50 when omitted', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = readTableRows(dbFile, 't');
  expect(r.limit).toBe(50);
});

test('negative or zero offset normalises to 0', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`, `INSERT INTO t (id) VALUES (1), (2)`]);

  const r = readTableRows(dbFile, 't', { offset: -50 });
  expect(r.offset).toBe(0);
  expect(r.rows.length).toBe(2);
});

test('unknown table → TableRowsError("unknown_table")', () => {
  seed([`CREATE TABLE only (id INTEGER PRIMARY KEY)`]);

  let err: unknown;
  try {
    readTableRows(dbFile, 'ghost');
  } catch (e) {
    err = e;
  }
  expect(err instanceof TableRowsError).toBeTruthy();
  expect((err as TableRowsError).code).toBe('unknown_table');
});

test('sqlite_* internal tables are not addressable', () => {
  seed([`CREATE TABLE keep (id INTEGER PRIMARY KEY)`]);

  let err: unknown;
  try {
    readTableRows(dbFile, 'sqlite_master');
  } catch (e) {
    err = e;
  }
  expect(err instanceof TableRowsError).toBeTruthy();
  expect((err as TableRowsError).code).toBe('unknown_table');
});

test('view rows are returned just like a table', () => {
  seed([
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, done INTEGER NOT NULL)`,
    `INSERT INTO todos (done) VALUES (0), (1), (0)`,
    `CREATE VIEW open_todos AS SELECT id FROM todos WHERE done = 0`,
  ]);

  const r = readTableRows(dbFile, 'open_todos');
  expect(r.totalCount).toBe(2);
  expect(r.columns[0]).toBe('id');
});

test('table name with quote → safely round-trips via quoted identifier', () => {
  seed([
    `CREATE TABLE "with""quote" (id INTEGER PRIMARY KEY, v TEXT)`,
    `INSERT INTO "with""quote" (v) VALUES ('ok')`,
  ]);

  const r = readTableRows(dbFile, 'with"quote');
  expect(r.totalCount).toBe(1);
  expect(r.rows[0]!.v).toBe('ok');
});
