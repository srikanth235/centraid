import { test, beforeAll, afterAll, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import {
  describeOp,
  readOp,
  writeOp,
  isSelectOnly,
  isWriteDml,
  SqlOpRefusal,
  SELECT_ROW_CAP,
} from './sql-ops.ts';

let workspace: string;
let dbFile: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'sql-ops-test-'));
  dbFile = path.join(workspace, 'data.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(
    `CREATE TABLE todos (id INTEGER PRIMARY KEY, title TEXT NOT NULL, done INTEGER DEFAULT 0)`,
  );
  db.exec(`INSERT INTO todos (title) VALUES ('one'), ('two')`);
  db.close();
});

afterAll(async () => {
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

test('isSelectOnly accepts SELECT and EXPLAIN, rejects DML/DDL', () => {
  expect(isSelectOnly('SELECT 1')).toBe(true);
  expect(isSelectOnly('  EXPLAIN QUERY PLAN SELECT 1')).toBe(true);
  expect(isSelectOnly('UPDATE todos SET done=1')).toBe(false);
  expect(isSelectOnly('DROP TABLE x')).toBe(false);
  expect(isSelectOnly('SELECT 1; DROP TABLE x')).toBe(false);
});

test('isWriteDml accepts INSERT/UPDATE/DELETE/REPLACE only', () => {
  expect(isWriteDml('INSERT INTO t VALUES (1)')).toBe(true);
  expect(isWriteDml('UPDATE t SET x=1')).toBe(true);
  expect(isWriteDml('DELETE FROM t')).toBe(true);
  expect(isWriteDml('REPLACE INTO t VALUES (1)')).toBe(true);
  expect(isWriteDml('SELECT 1')).toBe(false);
  expect(isWriteDml('CREATE TABLE x (id INTEGER)')).toBe(false);
  expect(isWriteDml('PRAGMA user_version')).toBe(false);
});

test('describeOp returns compact schema for the table', () => {
  const out = describeOp({ dataFile: dbFile });
  expect(out.tables.length).toBe(1);
  expect(out.tables[0]?.name).toBe('todos');
  const pk = out.tables[0]?.columns.find((c) => c.pk);
  expect(pk?.name).toBe('id');
});

test('readOp returns rows JSON with totalRows', () => {
  const out = readOp({ dataFile: dbFile, sql: 'SELECT id, title FROM todos ORDER BY id' });
  expect(out.columns).toEqual(['id', 'title']);
  expect(out.totalRows).toBe(2);
  expect(out.truncated).toBe(false);
  expect(out.rows[0]?.title).toBe('one');
});

test('readOp refuses a non-SELECT statement', () => {
  let err: unknown;
  try {
    readOp({ dataFile: dbFile, sql: 'UPDATE todos SET done = 1' });
  } catch (e) {
    err = e;
  }
  expect(err instanceof SqlOpRefusal).toBeTruthy();
  expect((err as SqlOpRefusal).message).toMatch(/only SELECT/);
});

test('writeOp applies a DML and reports rowsAffected; fires onWrite with table list', () => {
  const seen: string[][] = [];
  const out = writeOp({
    dataFile: dbFile,
    sql: 'UPDATE todos SET done = 1 WHERE id = 1',
    onWrite: (tables) => seen.push(tables),
  });
  expect(out.rowsAffected).toBe(1);
  expect(seen.length).toBe(1);
  expect(seen[0]).toEqual(['todos']);
});

test('writeOp refuses DDL', () => {
  let err: unknown;
  try {
    writeOp({ dataFile: dbFile, sql: 'DROP TABLE todos' });
  } catch (e) {
    err = e;
  }
  expect(err instanceof SqlOpRefusal).toBeTruthy();
  expect((err as SqlOpRefusal).message).toMatch(/DDL/);
});

test('writeOp refuses a SELECT', () => {
  let err: unknown;
  try {
    writeOp({ dataFile: dbFile, sql: 'SELECT 1' });
  } catch (e) {
    err = e;
  }
  expect(err instanceof SqlOpRefusal).toBeTruthy();
  expect((err as SqlOpRefusal).message).toMatch(/INSERT\/UPDATE\/DELETE\/REPLACE/);
});

test('readOp caps rows at SELECT_ROW_CAP', async () => {
  const big = path.join(workspace, 'big.sqlite');
  const db = new DatabaseSync(big);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, v INTEGER)');
  const stmt = db.prepare('INSERT INTO items (v) VALUES (?)');
  for (let i = 0; i < SELECT_ROW_CAP + 10; i++) stmt.run(i);
  db.close();
  const out = readOp({ dataFile: big, sql: 'SELECT v FROM items' });
  expect(out.rows.length).toBe(SELECT_ROW_CAP);
  expect(out.totalRows).toBe(SELECT_ROW_CAP + 10);
  expect(out.truncated).toBe(true);
});
