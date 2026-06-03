/*
 * Draft preview through the gateway (issue #141, "preview first").
 *
 * With `appsStoreRoot` set, `serve()` wires a `draftCodeDir` resolver that
 * points an app's code dir at its OPEN session worktree. A request under
 * `/centraid/_draft/<sessionId>/<appId>/…` then serves the STAGED draft —
 * static + handlers — against the app's live data, without publishing.
 *
 * We seed + publish an app, then open a session and overwrite its
 * index.html + query handler (the draft). The live path keeps serving the
 * published version; the `_draft` path serves the staged edits.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { WorktreeStore } from './worktree-store/index.js';
import { serve, type GatewayServeHandle } from './serve.ts';
import type { GatewayPaths } from './paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    appsDir: path.join(dir, 'apps'),
    identityDb: path.join(dir, 'identity.sqlite'),
    analyticsDb: path.join(dir, 'analytics.sqlite'),
    chatRunnerSessionDir: path.join(dir, 'chat-runner-sessions'),
  };
}

const MANIFEST = (appId: string): string =>
  JSON.stringify(
    {
      manifestVersion: 1,
      id: appId,
      name: 'Draftable App',
      version: '0.1.0',
      tables: [],
      actions: [],
      queries: [
        {
          name: 'ping',
          description: 'returns a marker',
          input: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    },
    null,
    2,
  );

/** Seed one published app on `main` via a session + publish. */
async function seedApp(appsStoreRoot: string, appId: string): Promise<void> {
  const store = new WorktreeStore({ root: appsStoreRoot });
  await store.init();
  const session = await store.openSession('seed');
  const appDir = path.join(session.worktreePath, 'apps', appId);
  await fs.mkdir(path.join(appDir, 'queries'), { recursive: true });
  await fs.writeFile(path.join(appDir, 'app.json'), MANIFEST(appId));
  await fs.writeFile(path.join(appDir, 'index.html'), '<!doctype html><head></head>PUBLISHED');
  await fs.writeFile(
    path.join(appDir, 'queries', 'ping.js'),
    "export default async () => ({ marker: 'published' });\n",
  );
  await store.publish({ sessionId: 'seed', appId, message: 'seed' });
  await store.closeSession('seed');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gateway-draft-${crypto.randomUUID()}-`));
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('serves a staged draft (static + handlers) while live keeps the published version', async () => {
  const appsStoreRoot = path.join(dataDir, 'code');
  await seedApp(appsStoreRoot, 'app');

  handle = await serve({ paths: pathsUnder(dataDir), appsStoreRoot });
  const store = handle.appsStore!;
  assert.ok(store, 'expected appsStore on the handle');

  // Open a session and stage a draft: new HTML + a changed query handler.
  await store.openSession('draft1');
  const draftDir = await store.snapshotSessionAppDir('draft1', 'app');
  await fs.writeFile(path.join(draftDir, 'index.html'), '<!doctype html><head></head>DRAFT');
  await fs.writeFile(
    path.join(draftDir, 'queries', 'ping.js'),
    "export default async () => ({ marker: 'draft' });\n",
  );

  const auth = { Authorization: `Bearer ${handle.token}` };

  // Live path: unchanged published static + handler.
  const liveHtml = await fetch(`${handle.url}/centraid/app/`, { headers: auth });
  assert.equal(liveHtml.status, 200);
  assert.match(await liveHtml.text(), /PUBLISHED/);

  const liveRead = await fetch(`${handle.url}/centraid/_tool/centraid_read`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'app', query: 'ping', input: {} }),
  });
  assert.deepEqual(await liveRead.json(), { marker: 'published' });

  // Draft path: staged static + the staged handler, against the same data.
  const draftHtml = await fetch(`${handle.url}/centraid/_draft/draft1/app/`, { headers: auth });
  assert.equal(draftHtml.status, 200, `draft index status ${draftHtml.status}`);
  const draftBody = await draftHtml.text();
  assert.match(draftBody, /DRAFT/, 'draft index should serve staged HTML');
  // The injected bridge must route tool calls through the draft shim so
  // the draft's handlers run (not the live ones).
  assert.match(
    draftBody,
    /\/centraid\/_draft\/draft1\/_tool\//,
    'draft bridge should pin the draft tool URL',
  );

  const draftRead = await fetch(`${handle.url}/centraid/_draft/draft1/_tool/centraid_read`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'app', query: 'ping', input: {} }),
  });
  assert.equal(draftRead.status, 200, `draft read status ${draftRead.status}`);
  assert.deepEqual(
    await draftRead.json(),
    { marker: 'draft' },
    'draft tool dispatch should run the staged handler',
  );
});

test('an unknown draft session yields 503 (no live fallback)', async () => {
  const appsStoreRoot = path.join(dataDir, 'code');
  await seedApp(appsStoreRoot, 'app');
  handle = await serve({ paths: pathsUnder(dataDir), appsStoreRoot });

  const res = await fetch(`${handle.url}/centraid/_draft/ghost/app/`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(res.status, 503, `expected 503 for unknown session, got ${res.status}`);
});
