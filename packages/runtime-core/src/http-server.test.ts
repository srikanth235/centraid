import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Runtime } from './runtime.ts';
import { startRuntimeHttpServer, type RuntimeHttpServerHandle } from './http-server.ts';

let workspace: string;
let server: RuntimeHttpServerHandle;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), `runtime-http-${crypto.randomUUID()}-`));
  const runtime = new Runtime({ appsDir: workspace });
  server = await startRuntimeHttpServer({ runtime });
  await runtime.bootstrap();
});

afterEach(async () => {
  await server.close().catch(() => undefined);
  await fs.rm(workspace, { recursive: true, force: true });
});

test('binds to loopback and rejects requests without the bearer token', async () => {
  assert.match(server.url, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(server.token.length, 64);

  const res = await fetch(`${server.url}/centraid/_apps`);
  assert.equal(res.status, 401);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'unauthorized');
});

test('serves the registry list when the bearer token matches', async () => {
  const res = await fetch(`${server.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as unknown[];
  assert.deepEqual(body, []);
});

test('returns 404 for unknown /centraid paths (with valid bearer)', async () => {
  const res = await fetch(`${server.url}/centraid/nope/whatever`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 404);
});

test('answers a CORS preflight (OPTIONS) with 204 and no auth required', async () => {
  const res = await fetch(`${server.url}/centraid/_apps`, {
    method: 'OPTIONS',
    headers: {
      Origin: 'null',
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization, content-type',
    },
  });
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
  assert.match(res.headers.get('access-control-allow-headers') ?? '', /authorization/i);
});

test('sets CORS headers on the 401 so the renderer can read the rejection', async () => {
  const res = await fetch(`${server.url}/centraid/_apps`);
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});

test('sets CORS headers on a successful authed response', async () => {
  const res = await fetch(`${server.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
});
