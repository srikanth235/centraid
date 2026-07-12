import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Runtime } from '../runtime.ts';
import {
  startRuntimeHttpServer,
  AUTHED_DEVICE_HEADER,
  type RuntimeHttpServerHandle,
} from './http-server.ts';

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
  expect(server.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(server.token.length).toBe(64);

  const res = await fetch(`${server.url}/centraid/_apps`);
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe('unauthorized');
});

test('serves the registry list when the bearer token matches', async () => {
  const res = await fetch(`${server.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as unknown[];
  expect(body).toEqual([]);
});

test('returns 404 for unknown /centraid paths (with valid bearer)', async () => {
  const res = await fetch(`${server.url}/centraid/nope/whatever`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(404);
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
  expect(res.status).toBe(204);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
  expect(res.headers.get('access-control-allow-methods') ?? '').toMatch(/POST/);
  expect(res.headers.get('access-control-allow-headers') ?? '').toMatch(/authorization/i);
});

test('sets CORS headers on the 401 so the renderer can read the rejection', async () => {
  const res = await fetch(`${server.url}/centraid/_apps`);
  expect(res.status).toBe(401);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
});

test('sets CORS headers on a successful authed response', async () => {
  const res = await fetch(`${server.url}/centraid/_apps`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('access-control-allow-origin')).toBe('*');
});

test('publicPaths serve without the bearer; everything else still 401s (issue #304)', async () => {
  const runtime = new Runtime({ appsDir: workspace });
  const publicServer = await startRuntimeHttpServer({
    runtime,
    publicPaths: ['/centraid/_vault/oauth/callback'],
    extraHandlers: [
      async (req, res) => {
        if (!(req.url ?? '').startsWith('/centraid/_vault/oauth/callback')) return false;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<h1>ceremony</h1>');
        return true;
      },
    ],
  });
  try {
    // The exact public path answers with NO Authorization header at all.
    const open = await fetch(`${publicServer.url}/centraid/_vault/oauth/callback?state=x&code=y`);
    expect(open.status).toBe(200);
    expect(await open.text()).toContain('ceremony');
    // Match is exact — a sibling path is NOT public.
    const sibling = await fetch(`${publicServer.url}/centraid/_vault/oauth/callback/deeper`);
    expect(sibling.status).toBe(401);
    const other = await fetch(`${publicServer.url}/centraid/_apps`);
    expect(other.status).toBe(401);
  } finally {
    await publicServer.close();
  }
});

test('authorizeBearer (issue #376): admin plane, device plane, and refusal', async () => {
  const runtime = new Runtime({ appsDir: workspace });
  const pluggableServer = await startRuntimeHttpServer({
    runtime,
    extraHandlers: [
      async (req, res) => {
        if ((req.url ?? '') !== '/centraid/_echo-device') return false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ deviceHeader: req.headers[AUTHED_DEVICE_HEADER] ?? null }));
        return true;
      },
    ],
    authorizeBearer: (bearer) => {
      if (bearer === 'admin-secret') return { plane: 'admin' };
      if (bearer === 'device-secret') return { plane: 'device', deviceKey: 'dev-abc' };
      return undefined;
    },
  });
  try {
    // An unrecognized bearer is refused, same 401 shape as the default check.
    const bad = await fetch(`${pluggableServer.url}/centraid/_apps`, {
      headers: { Authorization: 'Bearer nope' },
    });
    expect(bad.status).toBe(401);

    // The admin plane authenticates but stamps no device header.
    const admin = await fetch(`${pluggableServer.url}/centraid/_echo-device`, {
      headers: { Authorization: 'Bearer admin-secret' },
    });
    expect(admin.status).toBe(200);
    expect(await admin.json()).toEqual({ deviceHeader: null });

    // The device plane authenticates AND stamps the resolved device key.
    const device = await fetch(`${pluggableServer.url}/centraid/_echo-device`, {
      headers: { Authorization: 'Bearer device-secret' },
    });
    expect(device.status).toBe(200);
    expect(await device.json()).toEqual({ deviceHeader: 'dev-abc' });

    // A client cannot forge the device header directly — it is always
    // deleted before authorizeBearer decides anything.
    const forged = await fetch(`${pluggableServer.url}/centraid/_echo-device`, {
      headers: { Authorization: 'Bearer admin-secret', [AUTHED_DEVICE_HEADER]: 'forged-key' },
    });
    expect(forged.status).toBe(200);
    expect(await forged.json()).toEqual({ deviceHeader: null });
  } finally {
    await pluggableServer.close();
  }
});

test('publicPathPrefixes serve without the bearer for the whole subtree (issue #96)', async () => {
  const runtime = new Runtime({ appsDir: workspace });
  const publicServer = await startRuntimeHttpServer({
    runtime,
    publicPathPrefixes: ['/_centraid-hook'],
    extraHandlers: [
      async (req, res) => {
        if (!(req.url ?? '').startsWith('/_centraid-hook')) return false;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, url: req.url }));
        return true;
      },
    ],
  });
  try {
    // Any slug under the prefix answers with NO Authorization header.
    const open = await fetch(`${publicServer.url}/_centraid-hook/abc123`, { method: 'POST' });
    expect(open.status).toBe(200);
    expect(await open.json()).toEqual({ ok: true, url: '/_centraid-hook/abc123' });
    // A path outside the prefix still requires the bearer.
    const other = await fetch(`${publicServer.url}/centraid/_apps`);
    expect(other.status).toBe(401);
  } finally {
    await publicServer.close();
  }
});
