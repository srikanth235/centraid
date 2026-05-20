import { test, beforeEach, afterEach } from 'node:test';
import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Runtime } from './runtime.ts';
import { startRuntimeHttpServer, type RuntimeHttpServerHandle } from './http-server.ts';
import type { ChatRunner } from './chat-runner.ts';

let workspace: string;
let server: RuntimeHttpServerHandle;
let runtime: Runtime;

async function bootstrap(opts: { runner?: ChatRunner } = {}): Promise<void> {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-routes-${crypto.randomUUID()}-`),
  );
  runtime = new Runtime({ appsDir: workspace, chatRunner: opts.runner });
  server = await startRuntimeHttpServer({ runtime });
  await runtime.bootstrap();
}

afterEach(async () => {
  await server?.close().catch(() => undefined);
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

async function registerApp(appId: string): Promise<void> {
  const appDir = path.join(workspace, appId);
  await fs.mkdir(appDir, { recursive: true });
  await runtime.registry.register({ id: appId, path: appDir, mode: 'path' });
}

test('POST /_chat returns 503 when no runner is configured', async () => {
  await bootstrap();
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ windowId: 'w1', message: 'hi' }),
  });
  assert.equal(res.status, 503);
  const body = (await res.json()) as { error: string };
  assert.equal(body.error, 'no_chat_runner');
});

test('GET /_chat/windows is no longer a route (404)', async () => {
  await bootstrap();
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_chat/windows`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 404);
});

test('POST /_chat drives the runner and streams events', async () => {
  const runner: ChatRunner = {
    async run(input) {
      input.onEvent({ type: 'assistant.start' });
      input.onEvent({ type: 'assistant.delta', delta: 'Hi ' });
      input.onEvent({ type: 'assistant.delta', delta: 'there.' });
      input.onEvent({ type: 'final', text: 'Hi there.' });
    },
  };
  await bootstrap({ runner });
  await registerApp('demo');

  const res = await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ windowId: 'w1', message: 'hello' }),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
  const text = await res.text();
  // SSE frames: each event line + data line + blank.
  assert.match(text, /event: assistant.start/);
  assert.match(text, /event: assistant.delta/);
  assert.match(text, /"delta":"Hi "/);
  assert.match(text, /event: final/);
  assert.match(text, /event: end/);
});

test('POST /_chat passes the runner-owned session file under the scratch dir', async () => {
  let seenSessionFile = '';
  const runner: ChatRunner = {
    async run(input) {
      seenSessionFile = input.sessionFile;
      input.onEvent({ type: 'final', text: 'ok' });
    },
  };
  await bootstrap({ runner });
  await registerApp('demo');
  await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ windowId: 'w1', message: 'hello' }),
  }).then((r) => r.text());
  assert.equal(path.basename(seenSessionFile), 'w1.jsonl');
  assert.equal(path.dirname(seenSessionFile), runtime.chatRunnerSessionDir);
});

test('POST /_chat with invalid windowId returns 400', async () => {
  const runner: ChatRunner = { run: async () => undefined };
  await bootstrap({ runner });
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ windowId: '../escape', message: 'hello' }),
  });
  assert.equal(res.status, 400);
});

test('GET /centraid/_chat/runner-status returns "none" when no runner configured', async () => {
  await bootstrap();
  const res = await fetch(`${server.url}/centraid/_chat/runner-status`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { kind: string; ok: boolean };
  assert.equal(body.kind, 'none');
  assert.equal(body.ok, false);
});

test('runner error becomes an SSE error frame', async () => {
  const runner: ChatRunner = {
    async run() {
      throw new Error('model went poof');
    },
  };
  await bootstrap({ runner });
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ windowId: 'w1', message: 'hello' }),
  });
  const text = await res.text();
  assert.match(text, /event: error/);
  assert.match(text, /"message":"model went poof"/);
});

beforeEach(() => {
  // Ensure leftover state from a previous test doesn't bleed in.
  workspace = '';
});
