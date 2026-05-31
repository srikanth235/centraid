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

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gateway-runtime-${crypto.randomUUID()}-`));
  handle = await serve({ paths: pathsUnder(dataDir), secrets: noSecrets });
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('binds to loopback by default and mints a 32-byte random token', () => {
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(handle.token.length, 64);
});

test('mkdirs the appsDir on bootstrap so the registry has somewhere to live', async () => {
  const stat = await fs.stat(path.join(dataDir, 'apps'));
  assert.ok(stat.isDirectory());
});

test('returns the constructed stores on the handle for host introspection', () => {
  assert.ok(handle.userStore);
  assert.ok(handle.analyticsStore);
  assert.ok(handle.chatHistoryStore);
  assert.ok(handle.runtime);
});

test('rejects /centraid/_apps without the bearer token', async () => {
  const res = await fetch(`${handle.url}/centraid/_apps`);
  assert.equal(res.status, 401);
});

test('serves /centraid/_apps when the bearer token matches', async () => {
  const res = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as unknown[];
  assert.deepEqual(body, []);
});

test('honors a caller-supplied token instead of minting one', async () => {
  await handle.close();
  const fixed = 'fixed-token-for-test-purposes-only-do-not-use-elsewhere';
  handle = await serve({
    paths: pathsUnder(dataDir),
    secrets: noSecrets,
    token: fixed,
  });
  assert.equal(handle.token, fixed);
  const res = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${fixed}` },
  });
  assert.equal(res.status, 200);
});

test('honors a caller-supplied host (loopback alias still resolves)', async () => {
  await handle.close();
  handle = await serve({
    paths: pathsUnder(dataDir),
    secrets: noSecrets,
    host: '127.0.0.1',
    port: 0,
  });
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+$/);
});

test('runnerStatus is reachable and returns a RunnerStatus body', async () => {
  const res = await fetch(`${handle.url}/centraid/_chat/runner-status`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  // Whether the runner shows `ok` depends on whether codex / claude-code
  // is installed on the test host. We only assert the route is mounted
  // and returns a well-shaped status (the Electron embed has the same
  // default — prefs loader falls back to codex when no pref is set).
  assert.equal(res.status, 200);
  const body = (await res.json()) as { kind: string; ok: boolean };
  assert.ok(typeof body.kind === 'string' && body.kind.length > 0);
  assert.equal(typeof body.ok, 'boolean');
});
