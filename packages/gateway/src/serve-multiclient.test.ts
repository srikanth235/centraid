/*
 * Multi-client integration: prove that two independent HTTP clients
 * pointed at the same daemon see consistent gateway state. The "two
 * clients" stand in for desktop + mobile pointed at a shared standalone
 * gateway via the existing remote-gateway path.
 *
 * Scenario:
 *   1. An app is published onto the git-store `main` (issue #137).
 *   2. Client A fetches GET /centraid/_apps and sees it in the registry.
 *   3. Client B reads back the app's `index.html` via the `/centraid/<id>/`
 *      static-serve path (proves static serving works through the daemon
 *      from the live `main` worktree, not just the bearer check).
 *
 * No CLI spawn — we drive `serve()` in-process. The CLI smoke is
 * covered in `cli.test.ts`. This test focuses on the runtime contract
 * a second client expects after the gateway holds a published app.
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

/** Publish one app onto the git-store `main`, before serve() boots. */
async function seedApp(appsStoreRoot: string, appId: string): Promise<void> {
  const store = new WorktreeStore({ root: appsStoreRoot });
  await store.init();
  const session = await store.openSession('seed');
  const appDir = path.join(session.worktreePath, 'apps', appId);
  await fs.mkdir(appDir, { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify({ manifestVersion: 1, id: appId, name: 'multiclient-test', version: '0.1.0' }),
  );
  await fs.writeFile(path.join(appDir, 'index.html'), '<!doctype html><title>mc</title>');
  await store.publish({ sessionId: 'seed', appId, message: 'seed' });
  await store.closeSession('seed');
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `mc-gateway-${crypto.randomUUID()}-`));
  const appsStoreRoot = path.join(dataDir, 'code');
  await seedApp(appsStoreRoot, 'multiclient-test');
  handle = await serve({ paths: pathsUnder(dataDir), appsStoreRoot });
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('two clients see the published app consistently in the registry + static serve', async () => {
  // Client A: list — sees the app synced from `main`.
  const list = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(list.status, 200);
  const apps = (await list.json()) as Array<{ id: string }>;
  assert.ok(
    apps.some((a) => a.id === 'multiclient-test'),
    `expected to find multiclient-test in registry, got ${JSON.stringify(apps)}`,
  );

  // Client B: static-serve the app's index.html — proves the daemon's
  // `/centraid/<id>/` static path resolves the live `main` worktree, not
  // just the registry index.
  const html = await fetch(`${handle.url}/centraid/multiclient-test/`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, /<title>mc<\/title>/);
});
