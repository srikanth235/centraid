/*
 * Publish/session/files HTTP surface for the git-store backend
 * (issue #137). Drives a booted `serve({ appsStoreRoot })` over HTTP
 * end-to-end: open a session, write draft files, publish (with
 * gateway-side manifest validation), serve the published app, then
 * roll back. Replaces the tarball-upload flow.
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
    secrets: noSecrets,
    appsStoreRoot: path.join(dataDir, 'code'),
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
  assert.equal(res.status, 201, `open session: ${res.status}`);
}

async function putFile(sessionId: string, rel: string, content: string): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/todo/files/${rel}?sessionId=${sessionId}`, {
    method: 'PUT',
    headers: auth(),
    body: content,
  });
  assert.equal(res.status, 200, `put ${rel}: ${res.status} ${await res.text()}`);
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
  assert.equal(pub1.status, 201, `publish v1: ${JSON.stringify(pub1Body)}`);
  assert.equal(pub1Body.versionTag, 'todo/v1');

  // The published app serves from the main worktree.
  const html1 = await fetch(`${handle.url}/centraid/todo/`, { headers: auth() });
  assert.equal(html1.status, 200);
  assert.match(await html1.text(), /v1/);

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
  assert.equal(((await pub2.json()) as { versionTag: string }).versionTag, 'todo/v2');
  assert.match(
    await (await fetch(`${handle.url}/centraid/todo/`, { headers: auth() })).text(),
    /v2/,
  );

  // git-versions lists both, newest first; v2 is active.
  const versions = (await (
    await fetch(`${handle.url}/centraid/_apps/todo/git-versions`, { headers: auth() })
  ).json()) as { versions: Array<{ tag: string; active: boolean }> };
  assert.deepEqual(
    versions.versions.map((v) => v.tag),
    ['todo/v2', 'todo/v1'],
  );
  assert.deepEqual(
    versions.versions.map((v) => v.active),
    [true, false],
  );

  // Rollback to v1 — index.html reverts, no new tag minted, the
  // active flag flips from v2 to v1 on the next git-versions read.
  const rb = await fetch(`${handle.url}/centraid/_apps/todo/rollback`, {
    method: 'POST',
    headers: { ...auth(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ versionTag: 'todo/v1' }),
  });
  assert.equal(rb.status, 200, `rollback: ${await rb.text()}`);
  assert.match(
    await (await fetch(`${handle.url}/centraid/todo/`, { headers: auth() })).text(),
    /v1/,
  );
  const after = (await (
    await fetch(`${handle.url}/centraid/_apps/todo/git-versions`, { headers: auth() })
  ).json()) as { versions: Array<{ tag: string; active: boolean }> };
  assert.deepEqual(
    after.versions.map((v) => v.active),
    [false, true],
  );
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
  assert.equal(pub.status, 400);
  const body = (await pub.json()) as { error: string; message: string };
  assert.equal(body.error, 'invalid_manifest');
  assert.match(body.message, /queries\/ping\.js does not exist/);
});

test('files read returns the draft files written into a session', async () => {
  await openSession('s1');
  await putFile('s1', 'app.json', MANIFEST);
  await putFile('s1', 'queries/ping.js', '// ping\n');

  const res = await fetch(`${handle.url}/centraid/_apps/todo/files?sessionId=s1`, {
    headers: auth(),
  });
  assert.equal(res.status, 200);
  const { files } = (await res.json()) as { files: Array<{ path: string }> };
  const paths = files.map((f) => f.path).sort();
  assert.deepEqual(paths, ['app.json', 'queries/ping.js']);
});
