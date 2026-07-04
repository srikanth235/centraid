/*
 * Seed-on-first-draft-access for schema-safe editing (issue #144).
 *
 * Publishes an app whose migration creates a table + a row (so live
 * `data.sqlite` carries prod rows), then opens a draft session that adds a
 * *pending* migration. The first draft tool dispatch lazily seeds the
 * worktree's `data.sqlite` (VACUUM INTO live + replay the pending migration),
 * so the draft sees prod-seeded rows under the branched schema — while live
 * stays at the published schema and a draft write never touches live rows.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { serve, type GatewayServeHandle } from '../serve/serve.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, 'vault'),
    prefsFile: path.join(dir, 'prefs.json'),
  };
}

function auth(): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}` };
}

const MANIFEST = JSON.stringify({
  manifestVersion: 1,
  id: 'notes',
  name: 'Notes',
  version: '0.1.0',
  tables: [],
  actions: [],
  queries: [],
});

const MIGRATION_0001 =
  'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n' +
  "INSERT INTO notes (body) VALUES ('from-prod');\n";

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-seed-${crypto.randomUUID()}-`));
  handle = await serve({
    paths: pathsUnder(dataDir),
  });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function writeWorktreeFiles(sessionId: string, files: Record<string, string>): Promise<void> {
  const appDir = await (await handle.activeAppsStore()).snapshotSessionAppDir(sessionId, 'notes');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(appDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

/** `_sql` against a draft session (its branched data). */
async function draftSql(sessionId: string, sql: string): Promise<Response> {
  return fetch(`${handle.url}/centraid/_draft/${sessionId}/_tool/centraid_read`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'notes', query: '_sql', input: { sql } }),
  });
}

/** `_sql` against LIVE data. */
async function liveSql(sql: string, write = false): Promise<Response> {
  const tool = write ? 'centraid_write' : 'centraid_read';
  const key = write ? 'action' : 'query';
  return fetch(`${handle.url}/centraid/_tool/${tool}`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'notes', [key]: '_sql', input: { sql } }),
  });
}

test('first draft access seeds from prod + replays the draft pending migration', async () => {
  // Publish v1 — migration 0001 runs against live, so live carries one row.
  const store = await handle.activeAppsStore();
  await store.openSession('seed');
  await writeWorktreeFiles('seed', {
    'app.json': MANIFEST,
    'index.html': '<!doctype html>notes',
    'migrations/0001_init.sql': MIGRATION_0001,
  });
  const pub = await fetch(`${handle.url}/centraid/_apps/notes/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'seed', message: 'v1' }),
  });
  expect(pub.status).toBe(201);
  await store.closeSession('seed');

  // A draft session branches off main (inheriting app.json + 0001) and adds
  // a *pending* migration that's compatible with the existing row.
  await store.openSession('d1');
  await writeWorktreeFiles('d1', {
    'migrations/0002_add_done.sql':
      'ALTER TABLE notes ADD COLUMN done INTEGER NOT NULL DEFAULT 0;\n',
  });

  // First draft tool dispatch lazily seeds the worktree copy: the seeded row
  // is present AND the pending migration's `done` column exists on the draft.
  const draftRead = await draftSql('d1', 'SELECT body, done FROM notes');
  expect(draftRead.status).toBe(200);
  const draftRows = (await draftRead.json()) as { rows: Array<{ body: string; done: number }> };
  expect(draftRows.rows).toEqual([{ body: 'from-prod', done: 0 }]);

  // Live is untouched by the draft's pending migration — `SELECT *` returns
  // the row WITHOUT a `done` column (live schema is still at 0001).
  const liveRead = await liveSql('SELECT * FROM notes');
  expect(liveRead.status).toBe(200);
  const liveRows = (await liveRead.json()) as { rows: Array<Record<string, unknown>> };
  expect(liveRows.rows.length).toBe(1);
  expect(!('done' in liveRows.rows[0]!)).toBeTruthy();

  // A draft write lands only in the branched data — live row count unchanged.
  const draftWrite = await fetch(`${handle.url}/centraid/_draft/d1/_tool/centraid_write`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: 'notes',
      action: '_sql',
      input: { sql: "INSERT INTO notes (body, done) VALUES ('draft-only', 1)" },
    }),
  });
  expect(draftWrite.status).toBe(200);

  const draftCount = (await (await draftSql('d1', 'SELECT COUNT(*) AS n FROM notes')).json()) as {
    rows: Array<{ n: number }>;
  };
  expect(draftCount.rows[0]!.n).toBe(2);
  const liveCount = (await (await liveSql('SELECT COUNT(*) AS n FROM notes')).json()) as {
    rows: Array<{ n: number }>;
  };
  expect(liveCount.rows[0]!.n).toBe(1);
});

/** Publish a baseline `notes` app (migration 0001 → live row). */
async function publishBaseline(): Promise<void> {
  const store = await handle.activeAppsStore();
  await store.openSession('seed');
  await writeWorktreeFiles('seed', {
    'app.json': MANIFEST,
    'index.html': '<!doctype html>notes',
    'migrations/0001_init.sql': MIGRATION_0001,
  });
  const pub = await fetch(`${handle.url}/centraid/_apps/notes/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'seed', message: 'v1' }),
  });
  expect(pub.status).toBe(201);
  await store.closeSession('seed');
}

async function resetData(sessionId: string): Promise<Response> {
  return fetch(`${handle.url}/centraid/_apps/notes/reset-data`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
}

test('reset-data re-seeds the draft from a fresh prod snapshot', async () => {
  await publishBaseline();
  await (await handle.activeAppsStore()).openSession('d1');

  // Seed (first access) then mutate the draft.
  await draftSql('d1', 'SELECT 1');
  await fetch(`${handle.url}/centraid/_draft/d1/_tool/centraid_write`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app: 'notes',
      action: '_sql',
      input: { sql: "INSERT INTO notes (body) VALUES ('scratch')" },
    }),
  });
  const before = (await (await draftSql('d1', 'SELECT COUNT(*) AS n FROM notes')).json()) as {
    rows: Array<{ n: number }>;
  };
  expect(before.rows[0]!.n).toBe(2);

  // Reset wipes the scratch row — back to the single prod-seeded row.
  const reset = await resetData('d1');
  const body = (await reset.json()) as { seeded: boolean };
  expect(reset.status).toBe(200);
  expect(body.seeded).toBe(true);
  const after = (await (await draftSql('d1', 'SELECT body FROM notes')).json()) as {
    rows: Array<{ body: string }>;
  };
  expect(after.rows).toEqual([{ body: 'from-prod' }]);
});

test('reset-data surfaces an incompatible pending migration inline (422)', async () => {
  await publishBaseline();
  await (await handle.activeAppsStore()).openSession('d2');
  // A NOT-NULL column with no default fails against the prod-seeded row.
  await writeWorktreeFiles('d2', {
    'migrations/0002_bad.sql': 'ALTER TABLE notes ADD COLUMN title TEXT NOT NULL;\n',
  });

  const reset = await resetData('d2');
  const body = (await reset.json()) as { error: string; file: string };
  expect(reset.status).toBe(422);
  expect(body.error).toBe('sql_failed');
  expect(body.file).toBe('0002_bad.sql');
});

test('a failed seed migration leaves no draft DB, so a later access retries', async () => {
  await publishBaseline();
  const store = await handle.activeAppsStore();
  await store.openSession('d3');
  const appDir = await store.snapshotSessionAppDir('d3', 'notes');
  const draftDb = path.join(appDir, 'data.sqlite');

  // A pending migration incompatible with the prod-seeded row (NOT NULL, no
  // default) — seeding VACUUMs live in, then the migration fails.
  await writeWorktreeFiles('d3', {
    'migrations/0002_bad.sql': 'ALTER TABLE notes ADD COLUMN title TEXT NOT NULL;\n',
  });

  // First draft access fails (the migration error propagates) AND leaves no
  // half-seeded copy behind — otherwise the next access would preview against
  // a copied-but-unmigrated DB.
  const failed = await draftSql('d3', 'SELECT 1');
  expect(failed.status).toBe(500);
  expect(
    await fs
      .stat(draftDb)
      .then(() => true)
      .catch(() => false),
  ).toBe(false);

  // Fix-forward the migration; the next access re-seeds cleanly from scratch.
  await writeWorktreeFiles('d3', {
    'migrations/0002_bad.sql': 'ALTER TABLE notes ADD COLUMN title TEXT NOT NULL DEFAULT "";\n',
  });
  const ok = await draftSql('d3', 'SELECT body, title FROM notes');
  expect(ok.status).toBe(200);
  const rows = (await ok.json()) as { rows: Array<{ body: string; title: string }> };
  expect(rows.rows).toEqual([{ body: 'from-prod', title: '' }]);
});
