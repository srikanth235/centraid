import { afterEach, beforeEach, expect, test } from 'vitest';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import type { WorktreeStore } from '../worktree-store/index.js';
import type { GatewayPaths } from '../paths.js';
import { serve, type GatewayServeHandle } from './serve.js';

let dataDir: string;
let handle: GatewayServeHandle;

function pathsUnder(dir: string): GatewayPaths {
  return { vaultDir: path.join(dir, 'vault'), prefsFile: path.join(dir, 'prefs.json') };
}

async function seedApp(store: WorktreeStore, appId: string): Promise<void> {
  const sessionId = `seed-${appId}`;
  const session = await store.openSession(sessionId);
  const appDir = path.join(session.worktreePath, 'apps', appId);
  await fs.mkdir(path.join(appDir, 'queries'), { recursive: true });
  await fs.writeFile(
    path.join(appDir, 'app.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: appId,
      name: appId,
      version: '0.1.0',
      tables: [],
      actions: [],
      queries: [
        {
          name: 'ping',
          description: 'ping',
          input: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    }),
  );
  await fs.writeFile(
    path.join(appDir, 'index.html'),
    `<!doctype html><html><head></head><body>${appId}</body></html>`,
  );
  await fs.writeFile(
    path.join(appDir, 'queries', 'ping.js'),
    `export default async () => ({ app: '${appId}' });\n`,
  );
  await store.publish({ sessionId, appId, message: 'seed' });
  await store.closeSession(sessionId);
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `web-session-${crypto.randomUUID()}-`));
  handle = await serve({ paths: pathsUnder(dataDir) });
  const store = await handle.appsStore();
  await seedApp(store, 'alpha');
  await seedApp(store, 'beta');
  await handle.syncApps();
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function launch(appId: string): Promise<{ cookie: string; location: string }> {
  const minted = await fetch(`${handle.url}/centraid/_apps/${appId}/web-session`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${handle.token}`,
      Origin: 'http://127.0.0.1:4173',
      'content-type': 'application/json',
    },
    body: '{}',
  });
  expect(minted.status).toBe(200);
  const { launchPath } = (await minted.json()) as { launchPath: string };
  const redeemed = await fetch(new URL(launchPath, handle.url), { redirect: 'manual' });
  expect(redeemed.status).toBe(303);
  const setCookie = redeemed.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('SameSite=Strict');
  return {
    cookie: setCookie.split(';')[0] ?? '',
    location: redeemed.headers.get('location') ?? '',
  };
}

test('one-time launch establishes a cookie session that can load only its app', async () => {
  const session = await launch('alpha');
  expect(session.location).toBe('/centraid/alpha/');

  const alpha = await fetch(new URL(session.location, handle.url), {
    headers: { Cookie: session.cookie },
  });
  expect(alpha.status).toBe(200);
  expect(await alpha.text()).toContain('alpha');
  expect(alpha.headers.get('content-security-policy')).toContain(
    "frame-ancestors 'self' http://127.0.0.1:4173",
  );

  const beta = await fetch(`${handle.url}/centraid/beta/`, {
    headers: { Cookie: session.cookie },
  });
  expect(beta.status).toBe(401);

  const admin = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Cookie: session.cookie },
  });
  expect(admin.status).toBe(401);
});

test('app-session tool calls are forced to the session app', async () => {
  const session = await launch('alpha');
  const correct = await fetch(`${handle.url}/centraid/_tool/centraid_read`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'alpha', query: 'ping', input: {} }),
  });
  expect(correct.status).toBe(200);
  expect(await correct.json()).toEqual({ app: 'alpha' });

  const crossApp = await fetch(`${handle.url}/centraid/_tool/centraid_read`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ app: 'beta', query: 'ping', input: {} }),
  });
  expect(crossApp.status).toBe(403);
  expect(await crossApp.json()).toMatchObject({ error: 'app_session_scope' });
});

test('app sessions permit blob staging but not the wider vault surface', async () => {
  const session = await launch('alpha');
  const staged = await fetch(`${handle.url}/centraid/_vault/blobs?filename=sample.txt`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'content-type': 'text/plain' },
    body: 'sample document',
  });
  expect(staged.status).toBe(200);
  expect(await staged.json()).toMatchObject({ byteSize: 15, mediaType: 'text/plain' });

  const otherVaultRoute = await fetch(`${handle.url}/centraid/_vault/anything`, {
    headers: { Cookie: session.cookie },
  });
  expect(otherVaultRoute.status).toBe(401);
});

test('launch codes are single-use and forged scope headers do not authenticate', async () => {
  const minted = await fetch(`${handle.url}/centraid/_apps/alpha/web-session`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${handle.token}`, Origin: 'http://127.0.0.1:4173' },
  });
  const { launchPath } = (await minted.json()) as { launchPath: string };
  expect((await fetch(new URL(launchPath, handle.url), { redirect: 'manual' })).status).toBe(303);
  expect((await fetch(new URL(launchPath, handle.url), { redirect: 'manual' })).status).toBe(403);

  const forged = await fetch(`${handle.url}/centraid/alpha/`, {
    headers: {
      'x-centraid-web-app': 'alpha',
      'x-centraid-web-shell-origin': 'http://127.0.0.1:4173',
    },
  });
  expect(forged.status).toBe(401);
});

test('control session keeps the bearer out of browser storage and enforces its shell Origin', async () => {
  const established = await fetch(`${handle.url}/centraid/_web/control`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${handle.token}`,
      Origin: 'http://127.0.0.1:4173',
    },
  });
  expect(established.status).toBe(200);
  const setCookie = established.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain('HttpOnly');
  expect(setCookie).toContain('Path=/centraid/_web/control');
  const cookie = setCookie.split(';')[0] ?? '';

  const proxied = await fetch(
    `${handle.url}/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
    { headers: { Cookie: cookie, Origin: 'http://127.0.0.1:4173' } },
  );
  expect(proxied.status).toBe(200);
  expect((await proxied.json()) as Array<{ id: string }>).toEqual(
    expect.arrayContaining([expect.objectContaining({ id: 'alpha' })]),
  );

  const wrongOrigin = await fetch(
    `${handle.url}/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
    { headers: { Cookie: cookie, Origin: handle.url } },
  );
  expect(wrongOrigin.status).toBe(401);

  const noOrigin = await fetch(
    `${handle.url}/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
    { headers: { Cookie: cookie } },
  );
  expect(noOrigin.status).toBe(401);
});
