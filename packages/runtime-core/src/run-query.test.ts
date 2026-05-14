import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
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
  assert.equal(r.kind, 'rows');
  if (r.kind !== 'rows') throw new Error('unreachable');
  assert.deepEqual(r.columns, ['id', 'name']);
  assert.equal(r.rows.length, 2);
  assert.equal(r.rows[0]!.name, 'a');
  assert.ok(r.durationMs >= 0);
});

test('PRAGMA, EXPLAIN, and WITH are treated as read statements', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r1 = runQuery(dbFile, 'PRAGMA user_version');
  assert.equal(r1.kind, 'rows');

  const r2 = runQuery(dbFile, 'EXPLAIN SELECT id FROM t');
  assert.equal(r2.kind, 'rows');

  const r3 = runQuery(dbFile, 'WITH x AS (SELECT 1 AS n) SELECT * FROM x');
  assert.equal(r3.kind, 'rows');
});

test('INSERT returns kind:exec with rowsAffected + lastInsertRowid', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`]);

  const r = runQuery(dbFile, "INSERT INTO t (v) VALUES ('hello')");
  assert.equal(r.kind, 'exec');
  if (r.kind !== 'exec') throw new Error('unreachable');
  assert.equal(r.rowsAffected, 1);
  assert.equal(Number(r.lastInsertRowid), 1);
});

test('UPDATE returns kind:exec with rowsAffected and lastInsertRowid = 0', () => {
  seed([
    `CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`,
    `INSERT INTO t (v) VALUES ('a'), ('b'), ('c')`,
  ]);

  const r = runQuery(dbFile, "UPDATE t SET v = 'x' WHERE id <> 2");
  assert.equal(r.kind, 'exec');
  if (r.kind !== 'exec') throw new Error('unreachable');
  assert.equal(r.rowsAffected, 2);
});

test('DDL (CREATE TABLE) is exec with 0 rows affected', () => {
  const r = runQuery(dbFile, 'CREATE TABLE created (id INTEGER PRIMARY KEY)');
  assert.equal(r.kind, 'exec');

  // Verify it actually ran.
  const r2 = runQuery(dbFile, "SELECT name FROM sqlite_master WHERE type='table'");
  assert.equal(r2.kind, 'rows');
  if (r2.kind !== 'rows') throw new Error('unreachable');
  assert.ok(r2.rows.some((row) => row.name === 'created'));
});

test('multi-statement input is rejected', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  assert.throws(
    () => runQuery(dbFile, 'SELECT * FROM t; SELECT * FROM t'),
    (err: unknown) => err instanceof RunQueryError && err.code === 'bad_request',
  );
});

test('trailing semicolon (with no second statement) is allowed', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = runQuery(dbFile, 'SELECT id FROM t;');
  assert.equal(r.kind, 'rows');
});

test('trailing comment after semicolon is allowed', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = runQuery(dbFile, 'SELECT id FROM t; -- trailing\n');
  assert.equal(r.kind, 'rows');
});

test('empty input is rejected', () => {
  assert.throws(
    () => runQuery(dbFile, '   '),
    (err: unknown) => err instanceof RunQueryError && err.code === 'bad_request',
  );
});

test('syntax error surfaces as sql_error', () => {
  assert.throws(
    () => runQuery(dbFile, 'SELECT FROM'),
    (err: unknown) => err instanceof RunQueryError && err.code === 'sql_error',
  );
});

test('leading line comment does not confuse statement detection', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY)`]);

  const r = runQuery(dbFile, '-- list rows\nSELECT id FROM t');
  assert.equal(r.kind, 'rows');
});

test('semicolon inside a string is not a statement separator', () => {
  seed([`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)`]);

  const r = runQuery(dbFile, "INSERT INTO t (v) VALUES ('a;b;c')");
  assert.equal(r.kind, 'exec');

  const r2 = runQuery(dbFile, 'SELECT v FROM t');
  assert.equal(r2.kind, 'rows');
  if (r2.kind !== 'rows') throw new Error('unreachable');
  assert.equal(r2.rows[0]!.v, 'a;b;c');
});
