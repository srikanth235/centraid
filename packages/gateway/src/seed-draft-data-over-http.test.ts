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

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { serve, type GatewayServeHandle } from './serve.ts';
import type { GatewayPaths } from './paths.ts';
import type { SecretsProvider } from './secrets.ts';

let dataDir: string;
let handle: GatewayServeHandle;

const noSecrets: SecretsProvider = {
  async getProviderApiKey() {
    return undefined;
  },
};

function pathsUnder(dir: string): GatewayPaths {
  return {
    appsDir: path.join(dir, 'apps'),
    identityDb: path.join(dir, 'identity.sqlite'),
    analyticsDb: path.join(dir, 'analytics.sqlite'),
    chatRunnerSessionDir: path.join(dir, 'chat-runner-sessions'),
    codexHomeBaseDir: path.join(dir, 'codex-home'),
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
    secrets: noSecrets,
    appsStoreRoot: path.join(dataDir, 'code'),
  });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function writeWorktreeFiles(sessionId: string, files: Record<string, string>): Promise<void> {
  const appDir = await handle.appsStore!.snapshotSessionAppDir(sessionId, 'notes');
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
  const store = handle.appsStore!;
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
  assert.equal(pub.status, 201, `publish: ${await pub.text()}`);
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
  assert.equal(draftRead.status, 200, `draft read: ${await draftRead.clone().text()}`);
  const draftRows = (await draftRead.json()) as { rows: Array<{ body: string; done: number }> };
  assert.deepEqual(draftRows.rows, [{ body: 'from-prod', done: 0 }]);

  // Live is untouched by the draft's pending migration — `SELECT *` returns
  // the row WITHOUT a `done` column (live schema is still at 0001).
  const liveRead = await liveSql('SELECT * FROM notes');
  assert.equal(liveRead.status, 200);
  const liveRows = (await liveRead.json()) as { rows: Array<Record<string, unknown>> };
  assert.equal(liveRows.rows.length, 1);
  assert.ok(!('done' in liveRows.rows[0]!), 'live schema must not gain the draft column');

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
  assert.equal(draftWrite.status, 200, `draft write: ${await draftWrite.clone().text()}`);

  const draftCount = (await (await draftSql('d1', 'SELECT COUNT(*) AS n FROM notes')).json()) as {
    rows: Array<{ n: number }>;
  };
  assert.equal(draftCount.rows[0]!.n, 2, 'draft has both rows');
  const liveCount = (await (await liveSql('SELECT COUNT(*) AS n FROM notes')).json()) as {
    rows: Array<{ n: number }>;
  };
  assert.equal(liveCount.rows[0]!.n, 1, 'live untouched by the draft write');
});
