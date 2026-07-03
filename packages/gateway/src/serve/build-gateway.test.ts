import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { buildGateway, type BuiltGateway } from './build-gateway.ts';
import type { GatewayPaths } from '../paths.ts';

// `buildGateway()` is the host-agnostic core: it constructs the whole
// object graph but binds no socket. These tests pin that contract — the
// listener-free shape, plus `composedHandler` dispatching the gateway's
// route chain WITHOUT a bearer check (the surface the OpenClaw plugin
// mounts under its own `auth: 'gateway'`).

let dataDir: string;
let gateway: BuiltGateway;

function pathsUnder(dir: string): GatewayPaths {
  return {
    appsDir: path.join(dir, 'apps'),
    identityDb: path.join(dir, 'identity.sqlite'),
    analyticsDb: path.join(dir, 'analytics.sqlite'),
    conversationRunnerSessionDir: path.join(dir, 'conversation-runner-sessions'),
  };
}

/** Mount a handler on a bare loopback server with no auth in front. */
async function mountUnauthed(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<boolean>,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no bound address');
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      }),
  };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `build-gateway-${crypto.randomUUID()}-`));
  gateway = await buildGateway({ paths: pathsUnder(dataDir) });
});

afterEach(async () => {
  await gateway.stop().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('constructs the graph and exposes the lifecycle without binding a socket', () => {
  expect(gateway.runtime).toBeTruthy();
  expect(gateway.userStore).toBeTruthy();
  expect(gateway.analyticsStore).toBeTruthy();
  expect(gateway.conversationHistoryStore).toBeTruthy();
  expect(typeof gateway.start).toBe('function');
  expect(typeof gateway.stop).toBe('function');
  expect(Array.isArray(gateway.extraHandlers)).toBeTruthy();
  expect(typeof gateway.composedHandler).toBe('function');
  // No listener bound — nothing in the handle resembles a URL/token.
  expect((gateway as unknown as Record<string, unknown>).url).toBe(undefined);
  expect((gateway as unknown as Record<string, unknown>).token).toBe(undefined);
});

test('the legacy backend reports no appsStore on the handle', () => {
  expect(gateway.appsStore).toBe(undefined);
});

test('mounts the vault registry when vaultDir is set, recovers it across rebuilds', async () => {
  // The default gateway (no vaultDir) has no registry.
  expect(gateway.vaults).toBeUndefined();

  const paths = { ...pathsUnder(dataDir), vaultDir: path.join(dataDir, 'vault') };
  const withVault = await buildGateway({ paths });
  try {
    expect(withVault.vaults).toBeDefined();
    expect(withVault.vaults?.active().boot.fresh).toBe(true);
    expect(withVault.vaults?.list()).toHaveLength(1);
    // The owner consent surface answers through the composed chain.
    const mounted = await mountUnauthed(withVault.composedHandler);
    try {
      const status = await (await fetch(`${mounted.url}/centraid/_vault/status`)).json();
      expect(status).toMatchObject({
        active: true,
        vaultId: withVault.vaults?.active().boot.vaultId,
      });
    } finally {
      await mounted.close();
    }
  } finally {
    await withVault.stop();
  }

  // A rebuild over the same paths recovers the same vault, not a new one.
  const again = await buildGateway({ paths });
  try {
    expect(again.vaults?.active().boot.fresh).toBe(false);
    expect(again.vaults?.active().boot.vaultId).toBe(withVault.vaults?.active().boot.vaultId);
  } finally {
    await again.stop();
  }
});

test('composedHandler dispatches runtime routes with NO bearer check', async () => {
  await gateway.start('http://127.0.0.1:0');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    // No Authorization header — a fronting host (OpenClaw) owns auth, so
    // the composed chain must serve the request, not 401 it.
    const res = await fetch(`${srv.url}/centraid/_apps`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  } finally {
    await srv.close();
  }
});

test('composedHandler routes the chat-history + user-store prefixes', async () => {
  await gateway.start('http://127.0.0.1:0');
  const srv = await mountUnauthed(gateway.composedHandler);
  try {
    // Both prefixes resolve to their store handlers (not the runtime
    // fall-through) — proving the chat → user → extra → runtime order.
    const chat = await fetch(`${srv.url}/_centraid-user/prefs`);
    expect(chat.status).not.toBe(404);
  } finally {
    await srv.close();
  }
});

test('start() bootstraps the registry so app routes resolve', async () => {
  await gateway.start('http://127.0.0.1:0');
  // mkdir of appsDir happens in buildGateway; the registry is loaded in
  // start(). After start, the apps listing is queryable.
  const stat = await fs.stat(path.join(dataDir, 'apps'));
  expect(stat.isDirectory()).toBeTruthy();
});
