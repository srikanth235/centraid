import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Runtime } from '../runtime.ts';
import { startRuntimeHttpServer, type RuntimeHttpServerHandle } from './http-server.ts';
import type { ConversationRunner } from '../conversation/runner.ts';

let workspace: string;
let server: RuntimeHttpServerHandle;
let runtime: Runtime;

async function bootstrap(opts: { runner?: ConversationRunner } = {}): Promise<void> {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-routes-${crypto.randomUUID()}-`),
  );
  runtime = new Runtime({ appsDir: workspace, conversationRunner: opts.runner });
  server = await startRuntimeHttpServer({ runtime });
  await runtime.bootstrap();
}

afterEach(async () => {
  await server?.close().catch(() => undefined);
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

async function registerApp(appId: string): Promise<void> {
  // Test apps are uploaded-mode shells — empty wrapper dir, no
  // versions. The chat route surface doesn't read code, so we don't
  // need to commit an actual version for these tests.
  await runtime.registry.ensureUploaded(appId);
}

test('POST /_turn returns 503 when no runner is configured', async () => {
  await bootstrap();
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_turn`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ conversationId: 'w1', message: 'hi' }),
  });
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe('no_conversation_runner');
});

test('GET /_turn/windows is no longer a route (404)', async () => {
  await bootstrap();
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_turn/windows`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(404);
});

test('POST /_turn drives the runner and streams events', async () => {
  const runner: ConversationRunner = {
    async run(input) {
      input.onEvent({ type: 'assistant.start' });
      input.onEvent({ type: 'assistant.delta', delta: 'Hi ' });
      input.onEvent({ type: 'assistant.delta', delta: 'there.' });
      input.onEvent({ type: 'final', text: 'Hi there.' });
    },
  };
  await bootstrap({ runner });
  await registerApp('demo');

  const res = await fetch(`${server.url}/centraid/demo/_turn`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ conversationId: 'w1', message: 'hello' }),
  });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type') ?? '').toMatch(/text\/event-stream/);
  const text = await res.text();
  // SSE frames: each event line + data line + blank.
  expect(text).toMatch(/event: assistant.start/);
  expect(text).toMatch(/event: assistant.delta/);
  expect(text).toMatch(/"delta":"Hi "/);
  expect(text).toMatch(/event: final/);
  expect(text).toMatch(/event: end/);
});

test('POST /_turn passes the runner-owned session file under the scratch dir', async () => {
  let seenSessionFile = '';
  const runner: ConversationRunner = {
    async run(input) {
      seenSessionFile = input.sessionFile;
      input.onEvent({ type: 'final', text: 'ok' });
    },
  };
  await bootstrap({ runner });
  await registerApp('demo');
  await fetch(`${server.url}/centraid/demo/_turn`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'w1', message: 'hello' }),
  }).then((r) => r.text());
  expect(path.basename(seenSessionFile)).toBe('w1.jsonl');
  expect(path.dirname(seenSessionFile)).toBe(runtime.conversationRunnerSessionDir);
});

test('POST /_turn with invalid conversationId returns 400', async () => {
  const runner: ConversationRunner = { run: async () => undefined };
  await bootstrap({ runner });
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_turn`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ conversationId: '../escape', message: 'hello' }),
  });
  expect(res.status).toBe(400);
});

test('GET /centraid/_turn/runner-status returns "none" when no runner configured', async () => {
  await bootstrap();
  const res = await fetch(`${server.url}/centraid/_turn/runner-status`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { kind: string; ok: boolean };
  expect(body.kind).toBe('none');
  expect(body.ok).toBe(false);
});

test('runner error becomes an SSE error frame', async () => {
  const runner: ConversationRunner = {
    async run() {
      throw new Error('model went poof');
    },
  };
  await bootstrap({ runner });
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_turn`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'w1', message: 'hello' }),
  });
  const text = await res.text();
  expect(text).toMatch(/event: error/);
  expect(text).toMatch(/"message":"model went poof"/);
});

test('conversationLocks are per-runtime — two runtimes sharing appId+conversationId do not cross-block (#113)', async () => {
  // Cross-gateway isolation harness. Pre-#113 `conversationLocks` was a
  // module-level Map keyed by `${appId}::${conversationId}` with no gateway
  // scoping; two profiles installing the same template app would share
  // a single lock and serialise across users. The fix moves the map to
  // the Runtime instance — this test would have failed before #113.
  //
  // Setup: two runtimes A and B, each with their own apps dir + HTTP
  // server. Both register the same `appId` ('demo') and both receive a
  // POST with the same `conversationId` ('w1'). A's runner blocks on a
  // promise we control; B's runner resolves immediately. If the locks
  // were module-shared, B would queue behind A and never complete.

  // -- Setup runtime A: runner hangs on `releaseA`.
  let releaseA!: () => void;
  const aDone = new Promise<void>((resolve) => (releaseA = resolve));
  const runnerA: ConversationRunner = {
    async run(input) {
      input.onEvent({ type: 'assistant.start' });
      await aDone;
      input.onEvent({ type: 'final', text: 'a-final' });
    },
  };
  const workspaceA = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-iso-A-${crypto.randomUUID()}-`),
  );
  const runtimeA = new Runtime({ appsDir: workspaceA, conversationRunner: runnerA });
  const serverA = await startRuntimeHttpServer({ runtime: runtimeA });
  await runtimeA.bootstrap();
  await runtimeA.registry.ensureUploaded('demo');

  // -- Setup runtime B: runner finishes instantly.
  const runnerB: ConversationRunner = {
    async run(input) {
      input.onEvent({ type: 'final', text: 'b-final' });
    },
  };
  const workspaceB = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-iso-B-${crypto.randomUUID()}-`),
  );
  const runtimeB = new Runtime({ appsDir: workspaceB, conversationRunner: runnerB });
  const serverB = await startRuntimeHttpServer({ runtime: runtimeB });
  await runtimeB.bootstrap();
  await runtimeB.registry.ensureUploaded('demo');

  try {
    // Fire A first — its runner hangs. Don't await the response.
    const aResponsePromise = fetch(`${serverA.url}/centraid/demo/_turn`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${serverA.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ conversationId: 'w1', message: 'a' }),
    }).then((r) => r.text());

    // Give A's runner a tick to enter the lock + start streaming.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now fire B with the SAME appId+conversationId. If locks are
    // per-runtime (the fix), this resolves on its own without waiting
    // for A. If locks are module-shared (the bug), it queues behind A.
    const bText = await Promise.race([
      fetch(`${serverB.url}/centraid/demo/_turn`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serverB.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ conversationId: 'w1', message: 'b' }),
      }).then((r) => r.text()),
      new Promise<string>((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('B timed out — conversationLocks leaked across runtimes')),
          2000,
        ),
      ),
    ]);

    expect(bText).toMatch(/event: final/);
    expect(bText).toMatch(/"text":"b-final"/);

    // Now release A and confirm it completes too.
    releaseA();
    const aText = await aResponsePromise;
    expect(aText).toMatch(/"text":"a-final"/);
  } finally {
    releaseA();
    await Promise.all([
      serverA.close().catch(() => undefined),
      serverB.close().catch(() => undefined),
    ]);
    await Promise.all([
      fs.rm(workspaceA, { recursive: true, force: true }).catch(() => undefined),
      fs.rm(workspaceB, { recursive: true, force: true }).catch(() => undefined),
    ]);
  }
});

test('chat prompt resolves the manifest via the git-store code-dir override (#137)', async () => {
  // Under the git-store backend there is no legacy `current.json`, so the
  // manifest must resolve through `codeDirOverride` — a `getActiveVersion`
  // lookup misses and silently drops the declared-handler catalog, steering
  // the agent to `_sql`. Point the override at a code dir holding an app.json
  // with declared handlers; the turn's system prompt must name them (and must
  // NOT report the manifest unavailable).
  let seenPrompt = '';
  const runner: ConversationRunner = {
    async run(input) {
      seenPrompt = input.extraSystemPrompt;
      input.onEvent({ type: 'final', text: 'ok' });
    },
  };
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-manifest-${crypto.randomUUID()}-`),
  );
  const codeDir = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-code-${crypto.randomUUID()}-`),
  );
  await fs.writeFile(
    path.join(codeDir, 'app.json'),
    JSON.stringify({
      manifestVersion: 1,
      id: 'demo',
      name: 'Demo',
      version: '0.1.0',
      actions: [
        {
          name: 'addNote',
          confirmation: 'none',
          input: {
            type: 'object',
            properties: { text: { type: 'string', minLength: 1 } },
            required: ['text'],
            additionalProperties: false,
          },
        },
      ],
      queries: [
        {
          name: 'listNotes',
          input: { type: 'object', properties: {}, additionalProperties: false },
        },
      ],
    }),
  );
  runtime = new Runtime({
    appsDir: workspace,
    conversationRunner: runner,
    codeDirOverride: async () => codeDir,
  });
  server = await startRuntimeHttpServer({ runtime });
  await runtime.bootstrap();
  await runtime.registry.ensureUploaded('demo');

  await fetch(`${server.url}/centraid/demo/_turn`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'w1', message: 'hi' }),
  }).then((r) => r.text());

  await fs.rm(codeDir, { recursive: true, force: true });
  expect(seenPrompt).toMatch(/addNote/);
  expect(seenPrompt).toMatch(/listNotes/);
  expect(seenPrompt).not.toMatch(/manifest unavailable/);
});

beforeEach(() => {
  // Ensure leftover state from a previous test doesn't bleed in.
  workspace = '';
});
