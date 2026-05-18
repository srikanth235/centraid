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

test('GET /_chat/windows returns an empty list initially', async () => {
  await bootstrap();
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_chat/windows`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { windows: unknown[] };
  assert.deepEqual(body.windows, []);
});

test('POST /_chat drives the runner, streams events, and persists window meta', async () => {
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

  // Window was persisted.
  const list = await fetch(`${server.url}/centraid/demo/_chat/windows`, {
    headers: { Authorization: `Bearer ${server.token}` },
  }).then((r) => r.json() as Promise<{ windows: Array<{ id: string; turnCount: number }> }>);
  assert.equal(list.windows.length, 1);
  assert.equal(list.windows[0]?.id, 'w1');
  assert.equal(list.windows[0]?.turnCount, 1);
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

test('DELETE /_chat/windows/<id> tears down a window', async () => {
  const runner: ChatRunner = {
    async run(input) {
      input.onEvent({ type: 'final', text: 'ok' });
    },
  };
  await bootstrap({ runner });
  await registerApp('demo');
  // Create window first.
  await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ windowId: 'w1', message: 'hello' }),
  }).then((r) => r.text());

  const del = await fetch(`${server.url}/centraid/demo/_chat/windows/w1`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${server.token}` },
  });
  assert.equal(del.status, 200);
  const list = (await fetch(`${server.url}/centraid/demo/_chat/windows`, {
    headers: { Authorization: `Bearer ${server.token}` },
  }).then((r) => r.json())) as { windows: unknown[] };
  assert.equal(list.windows.length, 0);
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

test('transcript is persisted as JSONL and replayable via /history', async () => {
  const runner: ChatRunner = {
    async run(input) {
      input.onEvent({ type: 'assistant.delta', delta: 'Hello' });
      input.onEvent({
        type: 'tool.start',
        toolCallId: 't1',
        toolName: 'centraid_sql_read',
        args: { sql: 'SELECT 1' },
        sql: 'SELECT 1',
      });
      input.onEvent({
        type: 'tool.result',
        toolCallId: 't1',
        toolName: 'centraid_sql_read',
        ok: true,
        result: { rows: [[1]] },
      });
      input.onEvent({ type: 'final', text: 'Hello' });
      return { adapterKind: 'test', adapterSessionId: 'session-xyz' };
    },
  };
  await bootstrap({ runner });
  await registerApp('demo');

  await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ windowId: 'w1', message: 'hi' }),
  }).then((r) => r.text());

  const history = (await fetch(`${server.url}/centraid/demo/_chat/windows/w1/history`, {
    headers: { Authorization: `Bearer ${server.token}` },
  }).then((r) => r.json())) as {
    window: { adapterSessionId?: string };
    entries: Array<{ role: string; text?: string; toolName?: string }>;
  };
  const roles = history.entries.map((e) => e.role);
  assert.deepEqual(roles, ['user', 'tool', 'tool', 'assistant']);
  assert.equal(history.entries[0]?.text, 'hi');
  assert.equal(history.entries[3]?.text, 'Hello');
  assert.equal(history.window.adapterSessionId, 'session-xyz');
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
