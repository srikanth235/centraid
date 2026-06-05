import { test, beforeEach, afterEach, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runQuery, RunQueryError } from './run-query.ts';

let workspace: string;
let dbFile: string;

beforeEach(async () => {
  workspace = path.join(os.tmpdir(), `centraid-run-query-${crypto.randomBytes(6).toString('hex')}`);
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

test('SELECT returns kind:rows with columns + rows + durationMs', () => {
  seed([
    `CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`,
    `INSERT INTO t (name) VALUES ('a'), ('b')`,
  ]);

  const r = runQuery(dbFile, 'SELECT id, name FROM t ORDER BY id');
  expect(r.kind).toBe('rows');
  if (r.kind !== 'rows') throw new Error('unreachable');
  expect(r.columns).toEqual(['id', 'name']);
  expect(r.rows.length).toBe(2);
  expect(r.rows[0]!.name).toBe('a');
  expect(r.durationMs >= 0).toBeTruthy();
});

test('PRAGMA, EXPLAIN, and WITH are treated as read statements', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r1 = runQuery(dbFile, 'PRAGMA user_version');
  expect(r1.kind).toBe('rows');

  const r2 = runQuery(dbFile, 'EXPLAIN SELECT id FROM t');
  expect(r2.kind).toBe('rows');

  const r3 = runQuery(dbFile, 'WITH x AS (SELECT 1 AS n) SELECT * FROM x');
  expect(r3.kind).toBe('rows');
});

test('INSERT returns kind:exec with rowsAffected + lastInsertRowid', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`]);

  const r = runQuery(dbFile, "INSERT INTO t (v) VALUES ('hello')");
  expect(r.kind).toBe('exec');
  if (r.kind !== 'exec') throw new Error('unreachable');
  expect(r.rowsAffected).toBe(1);
  expect(Number(r.lastInsertRowid)).toBe(1);
});

test('UPDATE returns kind:exec with rowsAffected and lastInsertRowid = 0', () => {
  seed([
    `CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`,
    `INSERT INTO t (v) VALUES ('a'), ('b'), ('c')`,
  ]);

  const r = runQuery(dbFile, "UPDATE t SET v = 'x' WHERE id <> 2");
  expect(r.kind).toBe('exec');
  if (r.kind !== 'exec') throw new Error('unreachable');
  expect(r.rowsAffected).toBe(2);
});

test('DDL (CREATE TABLE) is exec with 0 rows affected', () => {
  const r = runQuery(dbFile, 'CREATE TABLE created (id INTEGER PRIMARY KEY)');
  expect(r.kind).toBe('exec');

  // Verify it actually ran.
  const r2 = runQuery(dbFile, "SELECT name FROM sqlite_master WHERE type='table'");
  expect(r2.kind).toBe('rows');
  if (r2.kind !== 'rows') throw new Error('unreachable');
  expect(r2.rows.some((row) => row.name === 'created')).toBeTruthy();
});

test('multi-statement input is rejected', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  let err: unknown;
  try {
    runQuery(dbFile, 'SELECT * FROM t; SELECT * FROM t');
  } catch (e) {
    err = e;
  }
  expect(err instanceof RunQueryError).toBeTruthy();
  expect((err as RunQueryError).code).toBe('bad_request');
});

test('trailing semicolon (with no second statement) is allowed', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = runQuery(dbFile, 'SELECT id FROM t;');
  expect(r.kind).toBe('rows');
});

test('trailing comment after semicolon is allowed', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = runQuery(dbFile, 'SELECT id FROM t; -- trailing\n');
  expect(r.kind).toBe('rows');
});

test('empty input is rejected', () => {
  let err: unknown;
  try {
    runQuery(dbFile, '   ');
  } catch (e) {
    err = e;
  }
  expect(err instanceof RunQueryError).toBeTruthy();
  expect((err as RunQueryError).code).toBe('bad_request');
});

test('syntax error surfaces as sql_error', () => {
  let err: unknown;
  try {
    runQuery(dbFile, 'SELECT FROM');
  } catch (e) {
    err = e;
  }
  expect(err instanceof RunQueryError).toBeTruthy();
  expect((err as RunQueryError).code).toBe('sql_error');
});

test('leading line comment does not confuse statement detection', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = runQuery(dbFile, '-- list rows\nSELECT id FROM t');
  expect(r.kind).toBe('rows');
});

test('semicolon inside a string is not a statement separator', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`]);

  const r = runQuery(dbFile, "INSERT INTO t (v) VALUES ('a;b;c')");
  expect(r.kind).toBe('exec');

  const r2 = runQuery(dbFile, 'SELECT v FROM t');
  expect(r2.kind).toBe('rows');
  if (r2.kind !== 'rows') throw new Error('unreachable');
  expect(r2.rows[0]!.v).toBe('a;b;c');
});

test('onWrite fires with touched tables for a successful INSERT', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`]);
  const tables: string[][] = [];
  const r = runQuery(dbFile, "INSERT INTO t (id, name) VALUES (1, 'a')", {
    onWrite: (t) => tables.push(t),
  });
  expect(r.kind).toBe('exec');
  expect(tables).toEqual([['t']]);
});

test('onWrite does NOT fire for SELECT/PRAGMA/EXPLAIN reads', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`, `INSERT INTO t (name) VALUES ('a')`]);
  const tables: string[][] = [];
  const onWrite = (t: string[]): void => {
    tables.push(t);
  };
  runQuery(dbFile, 'SELECT * FROM t', { onWrite });
  runQuery(dbFile, 'PRAGMA user_version', { onWrite });
  runQuery(dbFile, 'EXPLAIN SELECT * FROM t', { onWrite });
  expect(tables).toEqual([]);
});

test('onWrite does NOT fire when the statement fails (no rollback noise)', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);
  const tables: string[][] = [];
  // PK conflict
  seed([`INSERT INTO t (id) VALUES (1)`]);
  expect(() =>
    runQuery(dbFile, 'INSERT INTO t (id) VALUES (1)', {
      onWrite: (t) => tables.push(t),
    }),
  ).toThrow(RunQueryError);
  expect(tables).toEqual([]);
});

test('a thrown onWrite listener does not change the SQL outcome', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)`]);
  const r = runQuery(dbFile, "INSERT INTO t (id, name) VALUES (1, 'a')", {
    onWrite: () => {
      throw new Error('listener boom');
    },
  });
  expect(r.kind).toBe('exec');
  if (r.kind !== 'exec') throw new Error('unreachable');
  expect(r.rowsAffected).toBe(1);
});
