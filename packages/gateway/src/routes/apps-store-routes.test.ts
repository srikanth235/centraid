/*
 * Publish/session/files HTTP surface for the git-store backend
 * (issue #137). Drives a booted `serve()` over HTTP
 * end-to-end: open a session, write draft files, publish (with
 * gateway-side manifest validation), serve the published app, then
 * roll back. Replaces the tarball-upload flow.
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
  id: 'todo',
  name: 'Todo',
  version: '0.1.0',
  tables: [],
  actions: [],
  queries: [
    {
      name: 'ping',
      description: 'pong',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
  ],
});

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-routes-${crypto.randomUUID()}-`));
  handle = await serve({
    paths: pathsUnder(dataDir),
  });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function openSession(sessionId: string): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  });
  expect(res.status).toBe(201);
}

async function putFile(sessionId: string, rel: string, content: string): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/todo/files/${rel}?sessionId=${sessionId}`, {
    method: 'PUT',
    headers: auth(),
    body: content,
  });
  expect(res.status).toBe(200);
}

test('session → write → publish → serve → rollback round-trip', async () => {
  await openSession('s1');
  await putFile('s1', 'app.json', MANIFEST);
  await putFile('s1', 'queries/ping.js', 'export default async () => ({ pong: 1 });\n');
  await putFile('s1', 'index.html', '<!doctype html><title>todo</title>v1');

  // Publish v1.
  const pub1 = await fetch(`${handle.url}/centraid/_apps/todo/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'first' }),
  });
  const pub1Body = (await pub1.json()) as { versionTag: string };
  expect(pub1.status).toBe(201);
  expect(pub1Body.versionTag).toBe('todo/v1');

  // The published app serves from the main worktree.
  const html1 = await fetch(`${handle.url}/centraid/todo/`, { headers: auth() });
  expect(html1.status).toBe(200);
  expect(await html1.text()).toMatch(/v1/);

  // Second session bumps index.html and publishes v2.
  await openSession('s2');
  await putFile('s2', 'app.json', MANIFEST);
  await putFile('s2', 'queries/ping.js', 'export default async () => ({ pong: 2 });\n');
  await putFile('s2', 'index.html', '<!doctype html><title>todo</title>v2');
  const pub2 = await fetch(`${handle.url}/centraid/_apps/todo/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's2', message: 'second' }),
  });
  expect(((await pub2.json()) as { versionTag: string }).versionTag).toBe('todo/v2');
  expect(await (await fetch(`${handle.url}/centraid/todo/`, { headers: auth() })).text()).toMatch(
    /v2/,
  );

  // git-versions lists both, newest first; v2 is active.
  const versions = (await (
    await fetch(`${handle.url}/centraid/_apps/todo/git-versions`, { headers: auth() })
  ).json()) as { versions: Array<{ tag: string; active: boolean }> };
  expect(versions.versions.map((v) => v.tag)).toEqual(['todo/v2', 'todo/v1']);
  expect(versions.versions.map((v) => v.active)).toEqual([true, false]);

  // Rollback to v1 — index.html reverts, no new tag minted, the
  // active flag flips from v2 to v1 on the next git-versions read.
  const rb = await fetch(`${handle.url}/centraid/_apps/todo/rollback`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionTag: 'todo/v1' }),
  });
  expect(rb.status).toBe(200);
  expect(await (await fetch(`${handle.url}/centraid/todo/`, { headers: auth() })).text()).toMatch(
    /v1/,
  );
  const after = (await (
    await fetch(`${handle.url}/centraid/_apps/todo/git-versions`, { headers: auth() })
  ).json()) as { versions: Array<{ tag: string; active: boolean }> };
  expect(after.versions.map((v) => v.active)).toEqual([false, true]);
});

test('GET /_apps surfaces the app.json tile identity (iconKey/colorKey, #263)', async () => {
  await openSession('s1');
  const manifest = JSON.parse(MANIFEST) as Record<string, unknown>;
  await putFile(
    's1',
    'app.json',
    JSON.stringify({ ...manifest, iconKey: 'Todo', colorKey: 'indigo' }),
  );
  await putFile('s1', 'queries/ping.js', 'export default async () => ({ pong: 1 });\n');
  const pub = await fetch(`${handle.url}/centraid/_apps/todo/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'first' }),
  });
  expect(pub.status).toBe(201);

  const list = (await (
    await fetch(`${handle.url}/centraid/_apps`, { headers: auth() })
  ).json()) as Array<{ id: string; iconKey?: string; colorKey?: string; hasIndex: boolean }>;
  const row = list.find((a) => a.id === 'todo')!;
  expect(row.iconKey).toBe('Todo');
  expect(row.colorKey).toBe('indigo');
  expect(row.hasIndex).toBe(false);
});

test('publish rejects an invalid manifest (declared handler file missing)', async () => {
  await openSession('s1');
  // Manifest declares a `ping` query but we never write queries/ping.js.
  await putFile('s1', 'app.json', MANIFEST);
  await putFile('s1', 'index.html', 'x');

  const pub = await fetch(`${handle.url}/centraid/_apps/todo/publish`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 's1', message: 'broken' }),
  });
  expect(pub.status).toBe(400);
  const body = (await pub.json()) as { error: string; message: string };
  expect(body.error).toBe('invalid_manifest');
  expect(body.message).toMatch(/queries\/ping\.js does not exist/);
});

test('files read returns the draft files written into a session', async () => {
  await openSession('s1');
  await putFile('s1', 'app.json', MANIFEST);
  await putFile('s1', 'queries/ping.js', '// ping\n');

  const res = await fetch(`${handle.url}/centraid/_apps/todo/files?sessionId=s1`, {
    headers: auth(),
  });
  expect(res.status).toBe(200);
  const { files } = (await res.json()) as { files: Array<{ path: string }> };
  const paths = files.map((f) => f.path).sort();
  expect(paths).toEqual(['app.json', 'queries/ping.js']);
});

test('files DELETE removes a draft file from the session (#141)', async () => {
  await openSession('s1');
  await putFile('s1', 'app.json', MANIFEST);
  await putFile('s1', 'automations/wake/automation.json', '{}\n');
  await putFile('s1', 'automations/wake/handler.js', '// h\n');

  const del = await fetch(
    `${handle.url}/centraid/_apps/todo/files/automations/wake/handler.js?sessionId=s1`,
    { method: 'DELETE', headers: auth() },
  );
  const delBody = (await del.json()) as { path: string; deleted: boolean };
  expect(del.status).toBe(200);
  expect(delBody).toEqual({ path: 'automations/wake/handler.js', deleted: true });

  const after = (await (
    await fetch(`${handle.url}/centraid/_apps/todo/files?sessionId=s1`, { headers: auth() })
  ).json()) as { files: Array<{ path: string }> };
  expect(after.files.map((f) => f.path).sort()).toEqual([
    'app.json',
    'automations/wake/automation.json',
  ]);
});

test('files DELETE rejects a path escaping the app dir (#141)', async () => {
  await openSession('s1');
  await putFile('s1', 'app.json', MANIFEST);
  const del = await fetch(
    `${handle.url}/centraid/_apps/todo/files/..%2F..%2Fsecret.txt?sessionId=s1`,
    { method: 'DELETE', headers: auth() },
  );
  expect(del.status).toBe(400);
  expect(((await del.json()) as { error: string }).error).toBe('invalid_app_id');
});
