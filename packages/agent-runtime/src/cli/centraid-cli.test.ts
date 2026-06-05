/*
 * End-to-end smoke test for the centraid CLI bin. The CLI is invoked
 * as a subprocess (using the built dist/cli/centraid-cli.js) against a
 * temporary SQLite. This verifies both the JSON output contract and
 * the refusal exit codes that codex / claude-code rely on.
 *
 * The test depends on a prior `bun run build` for this package; turbo
 * configures `test` to run after `build` so the dist file exists.
 */

import { afterAll, beforeAll, expect, test } from 'vitest';
import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

// This test lives at src/cli/; the built CLI is at <pkg>/dist/cli/ (rootDir
// src mirrors into dist). Two levels up from src/cli reaches the package root.
const CLI_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'dist',
  'cli',
  'centraid-cli.js',
);

let workspace: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'centraid-cli-test-'));
  const dbFile = path.join(workspace, 'data.sqlite');
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

function runCli(...args: string[]): { stdout: string; stderr: string; code: number } {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: workspace,
    encoding: 'utf8',
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    code: typeof result.status === 'number' ? result.status : -1,
  };
}

test('sql describe emits the table schema as JSON on stdout', () => {
  const r = runCli('sql', 'describe');
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout) as {
    tables: Array<{ name: string; columns: Array<{ name: string; pk: boolean }> }>;
  };
  expect(parsed.tables.length).toBe(1);
  expect(parsed.tables[0]?.name).toBe('todos');
  const pk = parsed.tables[0]?.columns.find((c) => c.pk);
  expect(pk?.name).toBe('id');
});

test('sql read returns rows JSON', () => {
  const r = runCli('sql', 'read', 'SELECT id, title FROM todos ORDER BY id');
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout) as {
    columns: string[];
    rows: Array<Record<string, unknown>>;
    totalRows: number;
  };
  expect(parsed.columns).toEqual(['id', 'title']);
  expect(parsed.totalRows).toBe(2);
  expect(parsed.rows[0]?.title).toBe('one');
});

test('sql read refuses a non-SELECT statement with exit 64', () => {
  const r = runCli('sql', 'read', 'UPDATE todos SET done = 1');
  expect(r.code).toBe(64);
  expect(r.stderr).toMatch(/only SELECT/);
});

test('sql write applies a DML and reports rowsAffected', () => {
  const r = runCli('sql', 'write', 'UPDATE todos SET done = 1 WHERE id = 1');
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout) as { rowsAffected: number };
  expect(parsed.rowsAffected).toBe(1);
});

test('sql write refuses DDL with exit 64', () => {
  const r = runCli('sql', 'write', 'DROP TABLE todos');
  expect(r.code).toBe(64);
  expect(r.stderr).toMatch(/DDL/);
});

test('sql write refuses a SELECT with exit 64', () => {
  const r = runCli('sql', 'write', 'SELECT 1');
  expect(r.code).toBe(64);
  expect(r.stderr).toMatch(/INSERT\/UPDATE\/DELETE\/REPLACE/);
});

test('unknown subcommand exits with usage error', () => {
  const r = runCli('sql', 'gibberish');
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/unknown subcommand/);
});

test('preview snapshot reports exists:false when the file is missing', () => {
  const r = runCli('preview', 'snapshot');
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout) as { path: string; exists: boolean };
  expect(parsed.exists).toBe(false);
  expect(parsed.path).toMatch(/\.preview\/snapshot\.png$/);
});

test('preview snapshot returns size + age when the file exists', async () => {
  const dir = path.join(workspace, '.preview');
  await fs.mkdir(dir, { recursive: true });
  const png = path.join(dir, 'snapshot.png');
  await fs.writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const r = runCli('preview', 'snapshot');
  expect(r.code).toBe(0);
  const parsed = JSON.parse(r.stdout) as {
    path: string;
    exists: boolean;
    sizeBytes: number;
    mtimeMs: number;
    ageMs: number;
  };
  expect(parsed.exists).toBe(true);
  expect(parsed.sizeBytes).toBe(4);
  expect(parsed.mtimeMs > 0).toBeTruthy();
  expect(parsed.ageMs >= 0).toBeTruthy();
  await fs.rm(dir, { recursive: true, force: true });
});

test('preview with no subcommand exits with usage error', () => {
  const r = runCli('preview');
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/unknown preview subcommand/);
});

test('preview snapshot rejects extra args', () => {
  const r = runCli('preview', 'snapshot', 'extra');
  expect(r.code).toBe(2);
  expect(r.stderr).toMatch(/takes no arguments/);
});

test('CENTRAID_DATA_FILE overrides the default ./data.sqlite path', async () => {
  const alt = path.join(workspace, 'alt.sqlite');
  const db = new DatabaseSync(alt);
  db.exec(`CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)`);
  db.exec(`INSERT INTO notes (body) VALUES ('hello')`);
  db.close();
  const result = spawnSync(process.execPath, [CLI_PATH, 'sql', 'describe'], {
    cwd: workspace,
    env: { ...process.env, CENTRAID_DATA_FILE: alt },
    encoding: 'utf8',
  });
  expect(result.status).toBe(0);
  const parsed = JSON.parse(result.stdout) as { tables: Array<{ name: string }> };
  expect(parsed.tables[0]?.name).toBe('notes');
});
