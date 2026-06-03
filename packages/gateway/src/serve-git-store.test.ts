/*
 * Git-store backend integration (issue #137). With `appsStoreRoot`
 * set, `serve()` constructs an `WorktreeStore`, syncs every app on `main`
 * into the registry, and serves handlers + static from the live
 * `main` worktree instead of `<appsDir>/<id>/versions/<active>/`.
 *
 * We drive `serve()` in-process: seed an app through the WorktreeStore
 * directly (open session → write files → publish), then prove the
 * running gateway serves it — static index.html + the three-tool
 * dispatch + the registry list — all reading from the git worktree.
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
    conversationRunnerSessionDir: path.join(dir, 'conversation-runner-sessions'),
  };
}

/** Seed one app on `main` via a session + publish, before serve() boots. */
async function seedApp(appsStoreRoot: string, appId: string): Promise<void> {
  const store = new WorktreeStore({ root: appsStoreRoot });
  await store.init();
  const session = await store.openSession('seed');
  const appDir = path.join(session.worktreePath, 'apps', appId);
  await fs.mkdir(path.join(appDir, 'queries'), { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify(
      {
        manifestVersion: 1,
        id: appId,
        name: 'Git Store App',
        version: '0.1.0',
        tables: [],
        actions: [],
        queries: [
          {
            name: 'ping',
            description: 'returns pong',
            input: { type: 'object', properties: {}, additionalProperties: false },
          },
        ],
      },
      null,
      2,
    ),
  );
  await fs.writeFile(path.join(appDir, 'index.html'), '<!doctype html><title>git-store</title>OK');
  await fs.writeFile(
    path.join(appDir, 'queries', 'ping.js'),
    'export default async () => ({ pong: true });\n',
  );
  await store.publish({ sessionId: 'seed', appId, message: 'seed' });
  await store.closeSession('seed');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gateway-git-store-${crypto.randomUUID()}-`));
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('serves an app from the git-store main worktree, not versions/', async () => {
  const appsStoreRoot = path.join(dataDir, 'code');
  await seedApp(appsStoreRoot, 'gitapp');

  handle = await serve({ paths: pathsUnder(dataDir), appsStoreRoot });

  // The handle exposes the live WorktreeStore.
  assert.ok(handle.appsStore, 'expected appsStore on the handle');

  // Registry list reflects the app synced from main.
  const list = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(list.status, 200);
  const apps = (await list.json()) as Array<{ id: string }>;
  assert.ok(
    apps.some((a) => a.id === 'gitapp'),
    `expected gitapp in registry, got ${JSON.stringify(apps)}`,
  );

  // Static serve reads index.html from worktrees/main/<sha>/apps/gitapp/.
  const html = await fetch(`${handle.url}/centraid/gitapp/`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(html.status, 200, `index status ${html.status}`);
  assert.match(await html.text(), /git-store/);

  // The three-tool dispatch resolves the query handler from the worktree.
  const read = await fetch(`${handle.url}/centraid/_tool/centraid_read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'gitapp', query: 'ping', input: {} }),
  });
  assert.equal(read.status, 200, `read status ${read.status}: ${await read.clone().text()}`);
  assert.deepEqual(await read.json(), { pong: true });
});

test('without appsStoreRoot the handle has no appsStore (no code backend)', async () => {
  handle = await serve({ paths: pathsUnder(dataDir) });
  assert.equal(handle.appsStore, undefined);
});
