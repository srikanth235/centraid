/*
 * Template catalog over HTTP (issue #141). The gateway owns the bundled
 * @centraid/app-templates catalog and serves its display metadata at
 * `GET /centraid/_templates`, so the renderer reads it directly instead of
 * through a desktop IPC. We boot serve() and assert the route returns the
 * stripped metadata rows (no `files`/`source`), behind the bearer check.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { serve, type GatewayServeHandle } from './serve.ts';
import { makeTemplatesRouteHandler } from './templates-routes.ts';
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
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gateway-templates-${crypto.randomUUID()}-`));
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('GET /centraid/_templates returns stripped bundled metadata behind auth', async () => {
  handle = await serve({ paths: pathsUnder(dataDir), secrets: noSecrets });

  // No bearer → 401.
  const unauth = await fetch(`${handle.url}/centraid/_templates`);
  assert.equal(unauth.status, 401);

  const res = await fetch(`${handle.url}/centraid/_templates`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(res.status, 200);
  const templates = (await res.json()) as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(templates) && templates.length > 0, 'expected a non-empty catalog');

  for (const t of templates) {
    // Display metadata present…
    for (const key of ['id', 'name', 'desc', 'colorKey', 'iconKey', 'version']) {
      assert.ok(key in t, `template ${JSON.stringify(t.id)} missing ${key}`);
    }
    // …and the bulky resolver internals stripped.
    assert.ok(!('files' in t), 'files should be stripped from the wire response');
    assert.ok(!('source' in t), 'source should be stripped from the wire response');
  }
});

// Issue #141, Phase 5: the gateway owns the remote template *refresh* too —
// the fetch the desktop main process used to run before it dropped
// `@centraid/app-templates`. Constructing the handler with both a cache dir
// and a remote URL kicks a one-time best-effort fetch; without the URL it
// stays quiet.
test('handler refreshes the cache from the remote URL on construction', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(null, { status: 404 }); // manifest miss → fetch bails, never throws
  }) as typeof fetch;

  makeTemplatesRouteHandler({
    cacheDir: path.join(dataDir, 'tmpl-cache'),
    remoteTemplatesUrl: 'https://templates.example.test',
    fetchImpl,
  });
  // Fire-and-forget — let the microtask/IO turn run.
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(
    calls.some((u) => u.startsWith('https://templates.example.test')),
    `expected a remote fetch on construction; saw ${JSON.stringify(calls)}`,
  );
});

test('handler does not fetch when no remote URL is configured', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    return new Response(null, { status: 404 });
  }) as typeof fetch;

  makeTemplatesRouteHandler({ cacheDir: path.join(dataDir, 'tmpl-cache'), fetchImpl });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0, 'no remote URL → no fetch');
});
