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

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { serve, type GatewayServeHandle } from '../serve/serve.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    appsDir: path.join(dir, 'apps'),
    identityDb: path.join(dir, 'identity.sqlite'),
    analyticsDb: path.join(dir, 'analytics.sqlite'),
    conversationRunnerSessionDir: path.join(dir, 'conversation-runner-sessions'),
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
  expect(res.status).toBe(200);
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
  expect(res.status).toBe(201);
  expect(body.migrationsApplied).toEqual([1]);

  // Live data.sqlite carries the migrated schema + row, and user_version
  // advanced to 1.
  const rows = await liveSql('SELECT body FROM notes');
  expect(rows.rows).toEqual([{ body: 'seed' }]);
  expect(liveUserVersion()).toBe(1);
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
  expect((await publish('s1', 'v1')).status).toBe(201);

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
  expect(res.status).toBe(422);
  expect(body.error).toBe('sql_failed');
  expect(body.file).toBe('0002_add_title.sql');

  // Live data is untouched: user_version still 1, the failed code (v2
  // index.html) never went live.
  expect(liveUserVersion()).toBe(1);
  const html = await (await fetch(`${handle.url}/centraid/notes/`, { headers: auth() })).text();
  expect(html).not.toMatch(/v2/);
});

test('migrations run against the post-rebase tree: a colliding number aborts (#144)', async () => {
  // v1 establishes the table at user_version 1.
  await stage('s1', {
    'app.json': MANIFEST,
    'index.html': '<!doctype html>notes',
    'migrations/0001_init.sql':
      'CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL);\n',
  });
  expect((await publish('s1', 'v1')).status).toBe(201);

  // Two sessions branch off v1; each adds its own 0002. (`0001` is inherited
  // from main, so only the new migration is written.)
  await stage('sb', { 'migrations/0002_b.sql': 'ALTER TABLE notes ADD COLUMN b INTEGER;\n' });
  await stage('sa', { 'migrations/0002_a.sql': 'ALTER TABLE notes ADD COLUMN a INTEGER;\n' });

  // sb publishes first → 0002_b applies to live (user_version → 2).
  const pubB = await publish('sb', 'add b');
  expect(pubB.status).toBe(201);
  expect(liveUserVersion()).toBe(2);

  // sa now publishes. The store rebases it onto the new main, so its worktree
  // carries BOTH 0002_a and 0002_b — a duplicate id. Because migrations run
  // against the post-rebase tree (not sa's stale pre-rebase tree, where
  // 0002_a would be silently skipped as <= live user_version), the publish
  // aborts with the duplicate error and main never advances.
  const pubA = await publish('sa', 'add a');
  const bodyA = (await pubA.json()) as { error?: string };
  expect(pubA.status).toBe(400);
  expect(bodyA.error).toBe('duplicate');

  // Live is unchanged (still user_version 2, b applied, a never reached it);
  // no v3 tag was minted.
  expect(liveUserVersion()).toBe(2);
  const versions = (await (
    await fetch(`${handle.url}/centraid/_apps/notes/git-versions`, { headers: auth() })
  ).json()) as { versions: Array<{ tag: string }> };
  expect(versions.versions.map((v) => v.tag)).toEqual(['notes/v2', 'notes/v1']);
});
