/*
 * Webhook-trigger route on the CORE gateway (issue #96). The desktop/daemon
 * gateway (`serve()`) IS the always-on host for desktop-only users — a
 * `webhook` trigger must fire there directly. This boots a real
 * gateway, creates a webhook-triggered automation over the lifecycle HTTP
 * API (the desktop's real path — see `lifecycle-over-http.test.ts` for the
 * create-side assertions), then drives `/_centraid-hook/<id>` itself:
 * the shared secret is the whole auth story (no gateway owner bearer),
 * a wrong secret 401s, and an unknown id 404s.
 */

import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
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

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${handle.token}`, ...extra };
}

async function openSession(sessionId: string): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/_sessions`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sessionId }),
  });
  expect(res.status).toBe(201);
}

async function putFile(
  appId: string,
  sessionId: string,
  relPath: string,
  content: string,
): Promise<void> {
  const res = await fetch(
    `${handle.url}/centraid/_apps/${appId}/files/${relPath
      .split('/')
      .map(encodeURIComponent)
      .join('/')}?sessionId=${sessionId}`,
    { method: 'PUT', headers: auth(), body: content },
  );
  expect(res.status).toBe(200);
}

async function publish(appId: string, sessionId: string, message: string): Promise<void> {
  const res = await fetch(`${handle.url}/centraid/_apps/${appId}/publish`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ sessionId, message }),
  });
  expect(res.status).toBe(201);
}

/**
 * Create + publish a webhook-triggered automation over the real lifecycle
 * API (`POST /centraid/_automations`), then swap the scaffolded DRAFT
 * handler for a trivial one with no `ctx.tool` / `ctx.agent` calls.
 *
 * WHY: `runFire` opens the CLI dispatch surface unconditionally per fire
 * (`packages/automation/src/fire/fire.ts`), but the underlying agent
 * SESSION only spawns lazily on the first `ctx.tool` batch (see
 * `startLiveDispatch`'s doc comment) — "an automation that never calls a
 * tool never opens one." The scaffolded DEFAULT_HANDLER calls both, which
 * would make this test's outcome depend on whatever codex/claude CLI
 * happens to be on the test runner's PATH (or hang). Swapping in a
 * no-`ctx.*` handler keeps the fire hermetic while still exercising the
 * REAL webhook auth + cross-vault resolution + blocking-fire path end to
 * end — only the handler body is a stand-in.
 */
async function createWebhookAutomation(appId: string): Promise<{ id: string; secret: string }> {
  const res = await fetch(`${handle.url}/centraid/_automations`, {
    method: 'POST',
    headers: auth({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      id: appId,
      name: appId,
      prompt: 'fire on inbound webhook',
      triggers: [{ kind: 'webhook' }],
      publish: true,
    }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { webhook?: { id: string; secret: string; url: string } };
  expect(body.webhook).toBeTruthy();
  expect(body.webhook!.url).toMatch(/\/_centraid-hook\//);

  const sessionId = `edit-${appId}`;
  await openSession(sessionId);
  await putFile(
    appId,
    sessionId,
    `automations/${appId}/handler.js`,
    'export default async () => ({ summary: "fired" });\n',
  );
  await publish(appId, sessionId, 'swap in a no-dispatch handler for the test');

  return { id: body.webhook!.id, secret: body.webhook!.secret };
}

beforeEach(async () => {
  dataDir = await fs.mkdtemp(path.join(os.tmpdir(), `gw-webhook-${crypto.randomUUID()}-`));
  handle = await serve({ paths: pathsUnder(dataDir) });
});

afterEach(async () => {
  await handle?.close().catch(() => undefined);
  await fs.rm(dataDir, { recursive: true, force: true });
});

test('the correct secret fires the automation WITHOUT the gateway owner bearer token', async () => {
  const { id, secret } = await createWebhookAutomation('hookapp');

  // Deliberately no `auth()` header — the gateway owner's bearer is
  // intentionally absent. The shared webhook secret is the only auth here.
  const res = await fetch(`${handle.url}/_centraid-hook/${id}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ hello: 'world' }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { ok: boolean; runId?: string; error?: string };
  expect(body.ok).toBe(true);
  expect(body.runId).toBeTruthy();
  expect(body.error).toBeUndefined();
});

test('a wrong secret is rejected with 401, still without the gateway owner bearer token', async () => {
  const { id } = await createWebhookAutomation('hookapp2');

  const res = await fetch(`${handle.url}/_centraid-hook/${id}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer not-the-right-secret' },
  });
  expect(res.status).toBe(401);
  const body = (await res.json()) as { error: string };
  expect(body.error).toContain('secret');
});

test('an unknown webhook id is a 404', async () => {
  const res = await fetch(`${handle.url}/_centraid-hook/${'a'.repeat(24)}`, {
    method: 'POST',
    headers: { Authorization: 'Bearer whatever-the-caller-sends' },
  });
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe('unknown webhook');
});
