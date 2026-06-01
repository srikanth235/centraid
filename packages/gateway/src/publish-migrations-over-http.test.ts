/*
 * Migrations-on-publish for the git-store backend (issue #144).
 *
 * The critical standalone bug: the git-store publish path only commits +
 * ff-merges code, so a published schema change never reached live
 * `data.sqlite`. These tests drive `serve({ appsStoreRoot })` over HTTP and
 * assert that publishing a session that added a migration applies it to
 * live data — and that a migration incompatible with live rows aborts the
 * publish (422) without touching live data.
 *
 * Migrations are `.sql` files, which the draft-file PUT route does not
 * accept (it mirrors the editable-text allowlist); the agent authors them
 * via its native file tools straight into the worktree. The tests do the
 * same via `handle.appsStore.snapshotSessionAppDir`.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
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

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-pub-mig-${crypto.randomUUID()}-`));
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

/** Open a session and stage a file map (incl. `.sql`) directly into its worktree. */
async function stage(sessionId: string, files: Record<string, string>): Promise<void> {
  const store = handle.appsStore!;
  await store.openSession(sessionId);
  const appDir = await store.snapshotSessionAppDir(sessionId, 'notes');
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(appDir, rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content);
  }
}

async function publish(sessionId: string, message: string): Promise<Response> {
  return fetch(`${handle.url}/centraid/_apps/notes/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, message }),
  });
}

/** Run a single SELECT against LIVE data via the `_sql` read built-in. */
async function liveSql(sql: string): Promise<{ rows: Array<Record<string, unknown>> }> {
  const res = await fetch(`${handle.url}/centraid/_tool/centraid_read`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'notes', query: '_sql', input: { sql } }),
  });
  assert.equal(res.status, 200, `live _sql ${sql}: ${res.status} ${await res.clone().text()}`);
  return (await res.json()) as { rows: Array<Record<string, unknown>> };
}

/** Read `PRAGMA user_version` straight off the live DB (the `_sql` built-in
 *  refuses PRAGMA, so we open the file directly). */
function liveUserVersion(): number {
  const db = new DatabaseSync(path.join(dataDir, 'apps', 'notes', 'data.sqlite'));
  try {
    const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
    return row.user_version;
  } finally {
    db.close();
  }
}

test('publishing a session that added a migration applies it to live data', async () => {
  await stage('s1', {
    'app.json': MANIFEST,
    'index.html': '<!doctype html>notes',
    'migrations/0001_init.sql':
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n' +
      "INSERT INTO notes (body) VALUES ('seed');\n",
  });

  const res = await publish('s1', 'init schema');
  const body = (await res.json()) as { migrationsApplied?: number[]; versionTag?: string };
  assert.equal(res.status, 201, `publish: ${JSON.stringify(body)}`);
  assert.deepEqual(body.migrationsApplied, [1], 'migration 0001 should apply on publish');

  // Live data.sqlite carries the migrated schema + row, and user_version
  // advanced to 1.
  const rows = await liveSql('SELECT body FROM notes');
  assert.deepEqual(rows.rows, [{ body: 'seed' }]);
  assert.equal(liveUserVersion(), 1);
});

test('a migration incompatible with live rows aborts the publish (422), live data untouched', async () => {
  // First publish establishes live rows.
  await stage('s1', {
    'app.json': MANIFEST,
    'index.html': '<!doctype html>notes',
    'migrations/0001_init.sql':
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n' +
      "INSERT INTO notes (body) VALUES ('seed');\n",
  });
  assert.equal((await publish('s1', 'v1')).status, 201);

  // Second session adds a NOT-NULL column with no default — fails against
  // the existing row inside BEGIN IMMEDIATE.
  await stage('s2', {
    'app.json': MANIFEST,
    'index.html': '<!doctype html>notes v2',
    'migrations/0001_init.sql':
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n' +
      "INSERT INTO notes (body) VALUES ('seed');\n",
    'migrations/0002_add_title.sql': 'ALTER TABLE notes ADD COLUMN title TEXT NOT NULL;\n',
  });
  const res = await publish('s2', 'v2');
  const body = (await res.json()) as { error?: string; file?: string };
  assert.equal(res.status, 422, `expected 422, got ${res.status}: ${JSON.stringify(body)}`);
  assert.equal(body.error, 'sql_failed');
  assert.equal(body.file, '0002_add_title.sql');

  // Live data is untouched: user_version still 1, the failed code (v2
  // index.html) never went live.
  assert.equal(liveUserVersion(), 1, 'user_version must not advance on a failed migration');
  const html = await (await fetch(`${handle.url}/centraid/notes/`, { headers: auth() })).text();
  assert.doesNotMatch(html, /v2/, 'v2 code must not have merged (publish aborted before ff-merge)');
});
