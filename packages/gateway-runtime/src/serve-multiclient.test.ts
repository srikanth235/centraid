/*
 * Multi-client integration: prove that two independent HTTP clients
 * pointed at the same daemon see consistent gateway state. The "two
 * clients" stand in for desktop + mobile pointed at a shared standalone
 * gateway via the existing remote-gateway path.
 *
 * Scenario:
 *   1. Client A uploads a tiny app via POST /centraid/<id>/_uploads/.
 *   2. Client B fetches GET /centraid/_apps and sees it.
 *   3. Client B reads back the app's manifest via GET /centraid/<id>/
 *      static-serve path (proves static serving works through the
 *      daemon, not just the bearer check).
 *
 * No CLI spawn — we drive `serve()` in-process. The CLI smoke is
 * covered in `cli.test.ts`. This test focuses on the runtime contract
 * a second client expects after a first client writes.
 */

import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as tar from 'tar';
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

async function buildAppTarball(): Promise<Buffer> {
  const stage = await fs.mkdtemp(path.join(os.tmpdir(), `app-stage-${crypto.randomUUID()}-`));
  try {
    await fs.writeFile(
      path.join(stage, 'app.json'),
      JSON.stringify({ name: 'multiclient-test', version: '0.1.0' }),
    );
    await fs.writeFile(path.join(stage, 'index.html'), '<!doctype html><title>mc</title>');
    const chunks: Buffer[] = [];
    const stream = tar.create({ gzip: true, cwd: stage }, ['app.json', 'index.html']);
    for await (const chunk of stream as unknown as AsyncIterable<Buffer | string>) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks);
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `mc-gateway-${crypto.randomUUID()}-`));
  handle = await serve({ paths: pathsUnder(dataDir), secrets: noSecrets });
});

afterEach(async () => {
  await handle.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('one client uploads an app and a second client sees it in the registry', async () => {
  const tarball = await buildAppTarball();

  // Client A: upload. Route is POST /centraid/_apps/<id>/upload — apps are
  // registered implicitly by uploading, no separate POST /centraid/_apps.
  const upload = await fetch(`${handle.url}/centraid/_apps/multiclient-test/upload`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${handle.token}`,
      'Content-Type': 'application/gzip',
    },
    body: tarball,
  });
  assert.ok(
    upload.status >= 200 && upload.status < 300,
    `upload failed (status=${upload.status}): ${await upload.text()}`,
  );

  // Client B: list — should see the freshly uploaded app.
  const list = await fetch(`${handle.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(list.status, 200);
  const apps = (await list.json()) as Array<{ id: string }>;
  assert.ok(
    apps.some((a) => a.id === 'multiclient-test'),
    `expected to find multiclient-test in registry, got ${JSON.stringify(apps)}`,
  );

  // Client B: static-serve the uploaded index.html — proves the daemon's
  // `/centraid/<id>/` static path resolves the active version, not just
  // the registry index.
  const html = await fetch(`${handle.url}/centraid/multiclient-test/`, {
    headers: { Authorization: `Bearer ${handle.token}` },
  });
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, /<title>mc<\/title>/);
});
