/*
 * Git-store backend integration (issue #137, per-vault since #280). The
 * gateway constructs a `WorktreeStore` inside the ACTIVE vault's directory,
 * syncs every app on `main` into the registry, and serves handlers +
 * static from the live `main` worktree.
 *
 * We drive `serve()` in-process: seed an app through the vault's own
 * WorktreeStore (open session → write files → publish), re-settle the
 * workspace, then prove the running gateway serves it — static index.html
 * + the three-tool dispatch + the registry list — all reading from the
 * git worktree.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import type { WorktreeStore } from '../worktree-store/index.js';
import { serve, type GatewayServeHandle } from './serve.ts';
import type { GatewayPaths } from '../paths.ts';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return {
    vaultDir: path.join(dir, 'vault'),
    prefsFile: path.join(dir, 'prefs.json'),
  };
}

/** Seed one app on `main` via a session + publish, through the vault's store. */
async function seedApp(store: WorktreeStore, appId: string): Promise<void> {
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
  handle = await serve({ paths: pathsUnder(dataDir) });

  // The ACTIVE vault owns the code store (#280) — seed through it, then
  // re-settle the workspace so the registry syncs the published app.
  const store = await handle.appsStore();
  await seedApp(store, 'gitapp');
  await handle.syncApps();

  // Registry list reflects the app synced from main.
  const list = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  expect(list.status).toBe(200);
  const apps = (await list.json()) as Array<{ id: string }>;
  expect(apps.some((a) => a.id === 'gitapp')).toBeTruthy();

  // Static serve reads index.html from worktrees/main/<sha>/apps/gitapp/.
  const html = await fetch(`${handle.url}/centraid/gitapp/`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  expect(html.status).toBe(200);
  expect(await html.text()).toMatch(/git-store/);

  // The three-tool dispatch resolves the query handler from the worktree.
  const read = await fetch(`${handle.url}/centraid/_tool/centraid_read`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${handle.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ app: 'gitapp', query: 'ping', input: {} }),
  });
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ pong: true });
});

test('the code store lives inside the active vault directory (#280)', async () => {
  handle = await serve({ paths: pathsUnder(dataDir) });
  const store = await handle.appsStore();
  const vaultId = handle.vaults.current().boot.vaultId;
  expect(
    store.getActiveMainLink().startsWith(path.join(dataDir, 'vault', vaultId, 'code')),
  ).toBeTruthy();
});
