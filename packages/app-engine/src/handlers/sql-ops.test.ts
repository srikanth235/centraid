import { test, beforeAll, afterAll } from 'vitest';
import { strict as assert } from 'node:assert';
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
  assert.equal(isSelectOnly('SELECT 1'), true);
  assert.equal(isSelectOnly('  EXPLAIN QUERY PLAN SELECT 1'), true);
  assert.equal(isSelectOnly('UPDATE todos SET done=1'), false);
  assert.equal(isSelectOnly('DROP TABLE x'), false);
  assert.equal(isSelectOnly('SELECT 1; DROP TABLE x'), false);
});

test('isWriteDml accepts INSERT/UPDATE/DELETE/REPLACE only', () => {
  assert.equal(isWriteDml('INSERT INTO t VALUES (1)'), true);
  assert.equal(isWriteDml('UPDATE t SET x=1'), true);
  assert.equal(isWriteDml('DELETE FROM t'), true);
  assert.equal(isWriteDml('REPLACE INTO t VALUES (1)'), true);
  assert.equal(isWriteDml('SELECT 1'), false);
  assert.equal(isWriteDml('CREATE TABLE x (id INTEGER)'), false);
  assert.equal(isWriteDml('PRAGMA user_version'), false);
});

test('describeOp returns compact schema for the table', () => {
  const out = describeOp({ dataFile: dbFile });
  assert.equal(out.tables.length, 1);
  assert.equal(out.tables[0]?.name, 'todos');
  const pk = out.tables[0]?.columns.find((c) => c.pk);
  assert.equal(pk?.name, 'id');
});

test('readOp returns rows JSON with totalRows', () => {
  const out = readOp({ dataFile: dbFile, sql: 'SELECT id, title FROM todos ORDER BY id' });
  assert.deepEqual(out.columns, ['id', 'title']);
  assert.equal(out.totalRows, 2);
  assert.equal(out.truncated, false);
  assert.equal(out.rows[0]?.title, 'one');
});

test('readOp refuses a non-SELECT statement', () => {
  assert.throws(
    () => readOp({ dataFile: dbFile, sql: 'UPDATE todos SET done = 1' }),
    (err) => err instanceof SqlOpRefusal && /only SELECT/.test(err.message),
  );
});

test('writeOp applies a DML and reports rowsAffected; fires onWrite with table list', () => {
  const seen: string[][] = [];
  const out = writeOp({
    dataFile: dbFile,
    sql: 'UPDATE todos SET done = 1 WHERE id = 1',
    onWrite: (tables) => seen.push(tables),
  });
  assert.equal(out.rowsAffected, 1);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], ['todos']);
});

test('writeOp refuses DDL', () => {
  assert.throws(
    () => writeOp({ dataFile: dbFile, sql: 'DROP TABLE todos' }),
    (err) => err instanceof SqlOpRefusal && /DDL/.test(err.message),
  );
});

test('writeOp refuses a SELECT', () => {
  assert.throws(
    () => writeOp({ dataFile: dbFile, sql: 'SELECT 1' }),
    (err) => err instanceof SqlOpRefusal && /INSERT\/UPDATE\/DELETE\/REPLACE/.test(err.message),
  );
});

test('readOp caps rows at SELECT_ROW_CAP', async () => {
  const big = path.join(workspace, 'big.sqlite');
  const db = new DatabaseSync(big);
  db.exec('CREATE TABLE items (id INTEGER PRIMARY KEY, v INTEGER)');
  const stmt = db.prepare('INSERT INTO items (v) VALUES (?)');
  for (let i = 0; i < SELECT_ROW_CAP + 10; i++) stmt.run(i);
  db.close();
  const out = readOp({ dataFile: big, sql: 'SELECT v FROM items' });
  assert.equal(out.rows.length, SELECT_ROW_CAP);
  assert.equal(out.totalRows, SELECT_ROW_CAP + 10);
  assert.equal(out.truncated, true);
});
