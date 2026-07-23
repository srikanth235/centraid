import { tempDir } from '@centraid/test-kit/temp-dir';
import { afterEach, beforeEach, expect, test } from 'vitest';
import crypto from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { promises as fs } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorktreeStore } from '../worktree-store/index.js';
import type { GatewayPaths } from '../paths.js';
import { serve, type GatewayServeHandle } from './serve.js';
import { WebAppSessions } from './web-app-sessions.js';
import { WebControlSessionStore, hashControlToken } from './web-session-store.js';
import { runWithVaultContext } from './vault-context.js';

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
  dataDir = await tempDir(`web-session-${crypto.randomUUID()}-`);
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

test('app-session RPC calls are forced to the session app', async () => {
  const session = await launch('alpha');
  const correct = await fetch(`${handle.url}/centraid/alpha/queries/ping`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  expect(correct.status).toBe(200);
  expect(await correct.json()).toEqual({ app: 'alpha' });

  // App RPC now rides under the app's own prefix (issue #505), so a cross-app
  // path fails the session's path gate outright — it never reaches the runtime.
  const crossApp = await fetch(`${handle.url}/centraid/beta/queries/ping`, {
    method: 'POST',
    headers: { Cookie: session.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ input: {} }),
  });
  expect(crossApp.status).toBe(401);
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

test('active app session rejects a foreign Origin but still passes on shell/same/no origin', async () => {
  const session = await launch('alpha');

  // Same-origin as the gateway/API (app-iframe direct-HTTP mode): Origin host
  // equals the request host. Must pass.
  const sameOrigin = await fetch(new URL(session.location, handle.url), {
    headers: { Cookie: session.cookie, Origin: handle.url },
  });
  expect(sameOrigin.status).toBe(200);

  // The PWA shell origin (shellOrigin) must pass.
  const shellOrigin = await fetch(new URL(session.location, handle.url), {
    headers: { Cookie: session.cookie, Origin: 'http://127.0.0.1:4173' },
  });
  expect(shellOrigin.status).toBe(200);

  // No Origin header (Iroh bridge / same-origin GET subresource) must pass.
  const noOrigin = await fetch(new URL(session.location, handle.url), {
    headers: { Cookie: session.cookie },
  });
  expect(noOrigin.status).toBe(200);

  // A foreign origin — e.g. another port on the same host riding the cookie
  // through credentialed CORS — must be rejected.
  const foreign = await fetch(new URL(session.location, handle.url), {
    headers: { Cookie: session.cookie, Origin: 'http://127.0.0.1:9999' },
  });
  expect(foreign.status).toBe(401);
});

test('pairing a second control session does not invalidate the first', async () => {
  async function establish(): Promise<string> {
    const res = await fetch(`${handle.url}/centraid/_web/control`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${handle.token}`, Origin: 'http://127.0.0.1:4173' },
    });
    expect(res.status).toBe(200);
    return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
  }

  const first = await establish();
  const second = await establish();
  expect(first).not.toBe(second);

  // Both control cookies remain live after the second pairing.
  for (const cookie of [first, second]) {
    const proxied = await fetch(
      `${handle.url}/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
      { headers: { Cookie: cookie, Origin: 'http://127.0.0.1:4173' } },
    );
    expect(proxied.status).toBe(200);
  }
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

const SHELL = 'http://127.0.0.1:4173';

async function establishControl(): Promise<string> {
  const res = await fetch(`${handle.url}/centraid/_web/control`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${handle.token}`, Origin: SHELL },
  });
  expect(res.status).toBe(200);
  return (res.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
}

function proxyControl(cookie: string): Promise<Response> {
  return fetch(
    `${handle.url}/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
    {
      headers: { Cookie: cookie, Origin: SHELL },
    },
  );
}

test('a persisted control session still authorizes after a gateway restart', async () => {
  const controlsFile = path.join(dataDir, 'web-sessions.json');
  // Re-serve the same dataDir WITH persistence wired.
  await handle.close();
  handle = await serve({ paths: pathsUnder(dataDir), webSessions: { controlsFile } });
  await handle.syncApps();
  const cookie = await establishControl();
  expect((await proxyControl(cookie)).status).toBe(200);

  // "Restart": a brand-new gateway process on the same file — the browser
  // kept only its HttpOnly cookie, yet it must still authorize.
  await handle.close();
  handle = await serve({ paths: pathsUnder(dataDir), webSessions: { controlsFile } });
  await handle.syncApps();
  expect((await proxyControl(cookie)).status).toBe(200);
});

test('logout drops the control session server-side and expires the cookie', async () => {
  const cookie = await establishControl();
  expect((await proxyControl(cookie)).status).toBe(200);

  // An unauthenticated DELETE is rejected like any other.
  const noCookie = await fetch(`${handle.url}/centraid/_web/control`, {
    method: 'DELETE',
    headers: { Origin: SHELL },
  });
  expect(noCookie.status).toBe(401);

  // A DELETE with the cookie + matching Origin logs out: 200 + expiring cookie.
  const out = await fetch(`${handle.url}/centraid/_web/control`, {
    method: 'DELETE',
    headers: { Cookie: cookie, Origin: SHELL },
  });
  expect(out.status).toBe(200);
  expect(out.headers.get('set-cookie') ?? '').toContain('Max-Age=0');

  // The cookie no longer authorizes.
  expect((await proxyControl(cookie)).status).toBe(401);
});

test('a proxied DELETE (with ?path) is forwarded, not treated as a logout', async () => {
  const cookie = await establishControl();
  expect((await proxyControl(cookie)).status).toBe(200);

  // A DELETE carrying a proxied `?path=` is an ordinary API call (e.g. the
  // shell revoking a device), NOT a control-session logout. It must reach the
  // inner route — and, critically, must NOT expire the control cookie.
  const del = await fetch(
    `${handle.url}/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
    { method: 'DELETE', headers: { Cookie: cookie, Origin: SHELL } },
  );
  // Whatever the inner route answers (here _apps has no DELETE), it is not the
  // logout's cookie-expiring response.
  expect(del.headers.get('set-cookie') ?? '').not.toContain('Max-Age=0');

  // The session survived: the cookie still authorizes.
  expect((await proxyControl(cookie)).status).toBe(200);
});

test('an admin control session (no device key) is unaffected by revocation', async () => {
  const controlsFile = path.join(dataDir, 'web-sessions.json');
  await handle.close();
  // isDeviceValid always denies, but an admin-bearer control session carries
  // NO device key, so the revocation check never applies to it.
  handle = await serve({
    paths: pathsUnder(dataDir),
    webSessions: { controlsFile, isDeviceValid: () => false },
  });
  await handle.syncApps();
  const cookie = await establishControl();
  expect((await proxyControl(cookie)).status).toBe(200);
});

// ── Revocation propagation for device-bound sessions ──────────────────────
// These drive `WebAppSessions` directly: the e2e serve() rig has no device
// plane, so a bearer-established session never carries a deviceKey. Seeding a
// deviceKey-bound session in isolation is the only way to exercise the
// `isDeviceValid` gate the daemon wires in cli.ts.

function req(init: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}): IncomingMessage {
  const stream = Readable.from(init.body === undefined ? [] : [init.body]) as unknown as Record<
    string,
    unknown
  >;
  stream.url = init.url;
  stream.method = init.method ?? 'GET';
  stream.headers = init.headers ?? {};
  return stream as unknown as IncomingMessage;
}

class MockRes {
  statusCode = 200;
  body = '';
  private readonly outHeaders = new Map<string, string>();
  setHeader(name: string, value: string): void {
    this.outHeaders.set(name.toLowerCase(), value);
  }
  getHeader(name: string): string | undefined {
    return this.outHeaders.get(name.toLowerCase());
  }
  end(chunk?: string): void {
    if (chunk) this.body += chunk;
  }
}

test('a revoked device key kills a live CONTROL cookie and evicts its row', async () => {
  const controlsFile = path.join(dataDir, 'control-rev.json');
  const token = 'control-secret-token';
  const hash = hashControlToken(token);
  // Seed a persisted control row bound to a device key.
  WebControlSessionStore.open(controlsFile).establish({
    tokenHash: hash,
    vaultId: 'v1',
    deviceKey: 'dev-1',
    shellOrigin: SHELL,
  });

  let enrolled = true;
  const sessions = new WebAppSessions({ controlsFile, isDeviceValid: () => enrolled });
  const control = (): IncomingMessage =>
    req({
      url: `/centraid/_web/control?path=${encodeURIComponent('/centraid/_apps')}`,
      headers: { cookie: `__centraid_control=${token}`, origin: SHELL },
    });

  // Enrolled → authorizes as the device plane.
  expect(sessions.authorize(control())).toEqual({ plane: 'device', deviceKey: 'dev-1' });

  // Revoke the enrollment → the very next authorize fails and drops the row.
  enrolled = false;
  expect(sessions.authorize(control())).toBeUndefined();
  expect(WebControlSessionStore.open(controlsFile).find(hash)).toBeUndefined();
});

test('a revoked device key kills a live ACTIVE app session', async () => {
  let enrolled = true;
  const sessions = new WebAppSessions({ isDeviceValid: () => enrolled });

  // Mint a launch code inside a device-scoped vault context, then redeem it
  // for an app cookie — mirrors the mint→redeem HTTP flow, but lets us inject
  // the deviceKey the serve() rig can't.
  const mintRes = new MockRes();
  await runWithVaultContext({ vaultId: 'v1', deviceKey: 'dev-1' }, () =>
    sessions.handler(
      req({
        url: '/centraid/_apps/alpha/web-session',
        method: 'POST',
        headers: { origin: SHELL },
        body: '{}',
      }),
      mintRes as unknown as ServerResponse,
    ),
  );
  const { launchPath } = JSON.parse(mintRes.body) as { launchPath: string };

  const redeemRes = new MockRes();
  await sessions.handler(
    req({ url: launchPath, method: 'GET' }),
    redeemRes as unknown as ServerResponse,
  );
  const appCookie = (redeemRes.getHeader('set-cookie') ?? '').split(';')[0] ?? '';
  expect(appCookie).toContain('__centraid_app_');

  const appReq = (): IncomingMessage =>
    req({ url: '/centraid/alpha/', headers: { cookie: appCookie } });
  // Enrolled → authorizes.
  expect(sessions.authorize(appReq())).toEqual({ plane: 'device', deviceKey: 'dev-1' });
  // Revoked → the live app cookie is dead.
  enrolled = false;
  expect(sessions.authorize(appReq())).toBeUndefined();
});
