import { tempDir } from '@centraid/test-kit/temp-dir';
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

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { WorktreeStore } from '../worktree-store/index.js';
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
async function seedApp(store: WorktreeStore, appId: string): Promise<void> {
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
  dataDir = await tempDir(`gateway-draft-${crypto.randomUUID()}-`);
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('serves a staged draft (static + handlers) while live keeps the published version', async () => {
  handle = await serve({ paths: pathsUnder(dataDir) });
  const store = await handle.appsStore();
  await seedApp(store, 'app');
  await handle.syncApps();

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
  expect(liveHtml.status).toBe(200);
  expect(await liveHtml.text()).toMatch(/PUBLISHED/);

  const liveRead = await fetch(`${handle.url}/centraid/app/queries/ping`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  expect(await liveRead.json()).toEqual({ marker: 'published' });

  // Draft path: staged static + the staged handler, against the same data.
  const draftHtml = await fetch(`${handle.url}/centraid/_draft/draft1/app/`, { headers: auth });
  expect(draftHtml.status).toBe(200);
  const draftBody = await draftHtml.text();
  expect(draftBody).toMatch(/DRAFT/);
  // The injected bridge must route app RPC calls through the draft prefix so
  // the draft's handlers run (not the live ones).
  expect(draftBody).toMatch(/\/centraid\/_draft\/draft1\/app\//);

  const draftRead = await fetch(`${handle.url}/centraid/_draft/draft1/app/queries/ping`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  expect(draftRead.status).toBe(200);
  expect(await draftRead.json()).toEqual({ marker: 'draft' });
});

test('an unknown draft session yields 503 (no live fallback)', async () => {
  handle = await serve({ paths: pathsUnder(dataDir) });
  await seedApp(await handle.appsStore(), 'app');
  await handle.syncApps();

  const res = await fetch(`${handle.url}/centraid/_draft/ghost/app/`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  expect(res.status).toBe(503);
});
