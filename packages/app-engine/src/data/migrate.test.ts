import { test, beforeEach, afterEach, expect } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { runPendingMigrations, MigrationError } from './migrate.ts';

let workspace: string;
let extractedDir: string;
let dbFile: string;

beforeEach(async () => {
  workspace = path.join(os.tmpdir(), `centraid-migrate-${crypto.randomBytes(6).toString('hex')}`);
  extractedDir = path.join(workspace, 'extract');
  dbFile = path.join(workspace, 'data.sqlite');
  await fs.mkdir(extractedDir, { recursive: true });
});

afterEach(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

async function writeMigration(name: string, sql: string): Promise<void> {
  const dir = path.join(extractedDir, 'migrations');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, name), sql);
}

function withDb<T>(fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbFile);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function readUserVersion(): number {
  return withDb((db) => {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  });
}

function tableNames(): string[] {
  return withDb((db) =>
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name),
  );
}

test('no migrations dir → no-op, user_version stays 0', async () => {
  const out = await runPendingMigrations(extractedDir, dbFile);
  expect(out).toEqual({ applied: [], finalUserVersion: 0 });
  expect(readUserVersion()).toBe(0);
});

test('empty migrations dir → no-op', async () => {
  await fs.mkdir(path.join(extractedDir, 'migrations'));
  const out = await runPendingMigrations(extractedDir, dbFile);
  expect(out).toEqual({ applied: [], finalUserVersion: 0 });
});

test('single migration on a fresh DB applies and bumps user_version', async () => {
  await writeMigration('0001_init.sql', 'CREATE TABLE t (id INTEGER PRIMARY KEY);');
  const out = await runPendingMigrations(extractedDir, dbFile);
  expect(out).toEqual({ applied: [1], finalUserVersion: 1 });
  expect(readUserVersion()).toBe(1);
  expect(tableNames()).toEqual(['t']);
});

test('idempotent re-run — already-applied migrations are skipped', async () => {
  await writeMigration('0001_init.sql', 'CREATE TABLE t (id INTEGER PRIMARY KEY);');
  await runPendingMigrations(extractedDir, dbFile);

  // Second run with the same file: should be a no-op, user_version unchanged.
  const out = await runPendingMigrations(extractedDir, dbFile);
  expect(out).toEqual({ applied: [], finalUserVersion: 1 });
  expect(readUserVersion()).toBe(1);
});

test('three migrations applied in order; only pending ones run on second pass', async () => {
  await writeMigration('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  const first = await runPendingMigrations(extractedDir, dbFile);
  expect(first).toEqual({ applied: [1], finalUserVersion: 1 });

  await writeMigration('0002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
  await writeMigration('0003_c.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
  const second = await runPendingMigrations(extractedDir, dbFile);
  expect(second).toEqual({ applied: [2, 3], finalUserVersion: 3 });
  expect(tableNames()).toEqual(['a', 'b', 'c']);
});

test('gap rejection — missing id between two files', async () => {
  await writeMigration('0001_init.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  await writeMigration('0003_skip.sql', 'CREATE TABLE c (id INTEGER PRIMARY KEY);');
  let err: unknown;
  try {
    await runPendingMigrations(extractedDir, dbFile);
  } catch (e) {
    err = e;
  }
  expect(err instanceof MigrationError).toBeTruthy();
  expect((err as MigrationError).code).toBe('gap');
  expect((err as MigrationError).message).toMatch(/0002/);
  // Nothing applied because validation precedes the transaction.
  expect(readUserVersion()).toBe(0);
  expect(tableNames()).toEqual([]);
});

test('gap rejection — first file is not 0001', async () => {
  await writeMigration('0002_late.sql', 'CREATE TABLE x (id INTEGER PRIMARY KEY);');
  let err: unknown;
  try {
    await runPendingMigrations(extractedDir, dbFile);
  } catch (e) {
    err = e;
  }
  expect(err instanceof MigrationError).toBeTruthy();
  expect((err as MigrationError).code).toBe('gap');
});

test('bad name rejection — various malformed filenames', async () => {
  for (const bad of [
    '1_init.sql', // no leading zeros
    'init.sql', // no id prefix
    '0001_init.txt', // wrong extension
    '0001-init.sql', // dash separator instead of underscore
    '0001_INIT.sql', // uppercase slug
    '0001_.sql', // empty slug
  ]) {
    await fs.rm(path.join(extractedDir, 'migrations'), { recursive: true, force: true });
    await writeMigration(bad, 'SELECT 1;');
    let err: unknown;
    try {
      await runPendingMigrations(extractedDir, dbFile);
    } catch (e) {
      err = e;
    }
    expect(err instanceof MigrationError, `expected MigrationError for "${bad}"`).toBeTruthy();
    expect((err as MigrationError).code, `bad_name expected for "${bad}"`).toBe('bad_name');
    expect((err as MigrationError).file).toBe(bad);
  }
});

test('duplicate id rejection', async () => {
  await writeMigration('0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  await writeMigration('0001_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
  let err: unknown;
  try {
    await runPendingMigrations(extractedDir, dbFile);
  } catch (e) {
    err = e;
  }
  expect(err instanceof MigrationError).toBeTruthy();
  expect((err as MigrationError).code).toBe('duplicate');
});

test('SQL failure rolls back the entire batch — earlier migrations also discarded', async () => {
  await writeMigration('0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  await writeMigration('0002_b.sql', 'CREATE TABLE b (id INTEGER PRIMARY KEY);');
  await writeMigration('0003_broken.sql', 'NOT VALID SQL;');
  let err: unknown;
  try {
    await runPendingMigrations(extractedDir, dbFile);
  } catch (e) {
    err = e;
  }
  expect(err instanceof MigrationError).toBeTruthy();
  expect((err as MigrationError).code).toBe('sql_failed');
  expect((err as MigrationError).file).toBe('0003_broken.sql');
  const sqlError = (err as MigrationError).sqlError;
  expect(sqlError && sqlError.length > 0, 'sqlError should be populated').toBeTruthy();
  expect(readUserVersion()).toBe(0);
  expect(tableNames()).toEqual([]);
});

test('SQL failure on later migration leaves prior runs intact', async () => {
  // Apply 0001 cleanly.
  await writeMigration('0001_a.sql', 'CREATE TABLE a (id INTEGER PRIMARY KEY);');
  await runPendingMigrations(extractedDir, dbFile);
  expect(readUserVersion()).toBe(1);

  // Now ship 0001 + 0002 (broken). 0002 fails → user_version stays at 1, table a stays.
  await writeMigration('0002_broken.sql', 'NOT VALID SQL;');
  let err: unknown;
  try {
    await runPendingMigrations(extractedDir, dbFile);
  } catch (e) {
    err = e;
  }
  expect(err instanceof MigrationError).toBeTruthy();
  expect((err as MigrationError).code).toBe('sql_failed');
  expect(readUserVersion()).toBe(1);
  expect(tableNames()).toEqual(['a']);
});

test('migration containing BEGIN/COMMIT is rejected as sql_failed', async () => {
  // SQLite refuses nested transactions; the runner already opens one.
  await writeMigration(
    '0001_nested.sql',
    'BEGIN; CREATE TABLE a (id INTEGER PRIMARY KEY); COMMIT;',
  );
  let err: unknown;
  try {
    await runPendingMigrations(extractedDir, dbFile);
  } catch (e) {
    err = e;
  }
  expect(err instanceof MigrationError).toBeTruthy();
  expect((err as MigrationError).code).toBe('sql_failed');
  expect((err as MigrationError).file).toBe('0001_nested.sql');
  expect(readUserVersion()).toBe(0);
});

test('multi-statement DDL within a single migration is supported', async () => {
  await writeMigration(
    '0001_init.sql',
    `CREATE TABLE a (id INTEGER PRIMARY KEY);
     CREATE TABLE b (id INTEGER PRIMARY KEY);
     CREATE INDEX idx_a ON a(id);`,
  );
  const out = await runPendingMigrations(extractedDir, dbFile);
  expect(out).toEqual({ applied: [1], finalUserVersion: 1 });
  expect(tableNames()).toEqual(['a', 'b']);
});
