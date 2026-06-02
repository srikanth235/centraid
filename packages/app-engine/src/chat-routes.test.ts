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
  // Test apps are uploaded-mode shells — empty wrapper dir, no
  // versions. The chat route surface doesn't read code, so we don't
  // need to commit an actual version for these tests.
  await runtime.registry.ensureUploaded(appId);
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
    body: JSON.stringify({ conversationId: 'w1', message: 'hi' }),
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
    body: JSON.stringify({ conversationId: 'w1', message: 'hello' }),
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
    body: JSON.stringify({ conversationId: 'w1', message: 'hello' }),
  }).then((r) => r.text());
  assert.equal(path.basename(seenSessionFile), 'w1.jsonl');
  assert.equal(path.dirname(seenSessionFile), runtime.chatRunnerSessionDir);
});

test('POST /_chat with invalid conversationId returns 400', async () => {
  const runner: ChatRunner = { run: async () => undefined };
  await bootstrap({ runner });
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${server.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ conversationId: '../escape', message: 'hello' }),
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
    body: JSON.stringify({ conversationId: 'w1', message: 'hello' }),
  });
  const text = await res.text();
  assert.match(text, /event: error/);
  assert.match(text, /"message":"model went poof"/);
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
  const runnerA: ChatRunner = {
    async run(input) {
      input.onEvent({ type: 'assistant.start' });
      await aDone;
      input.onEvent({ type: 'final', text: 'a-final' });
    },
  };
  const workspaceA = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-iso-A-${crypto.randomUUID()}-`),
  );
  const runtimeA = new Runtime({ appsDir: workspaceA, chatRunner: runnerA });
  const serverA = await startRuntimeHttpServer({ runtime: runtimeA });
  await runtimeA.bootstrap();
  await runtimeA.registry.ensureUploaded('demo');

  // -- Setup runtime B: runner finishes instantly.
  const runnerB: ChatRunner = {
    async run(input) {
      input.onEvent({ type: 'final', text: 'b-final' });
    },
  };
  const workspaceB = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-iso-B-${crypto.randomUUID()}-`),
  );
  const runtimeB = new Runtime({ appsDir: workspaceB, chatRunner: runnerB });
  const serverB = await startRuntimeHttpServer({ runtime: runtimeB });
  await runtimeB.bootstrap();
  await runtimeB.registry.ensureUploaded('demo');

  try {
    // Fire A first — its runner hangs. Don't await the response.
    const aResponsePromise = fetch(`${serverA.url}/centraid/demo/_chat`, {
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
      fetch(`${serverB.url}/centraid/demo/_chat`, {
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

    assert.match(bText, /event: final/);
    assert.match(bText, /"text":"b-final"/);

    // Now release A and confirm it completes too.
    releaseA();
    const aText = await aResponsePromise;
    assert.match(aText, /"text":"a-final"/);
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
  const runner: ChatRunner = {
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
    chatRunner: runner,
    codeDirOverride: async () => codeDir,
  });
  server = await startRuntimeHttpServer({ runtime });
  await runtime.bootstrap();
  await runtime.registry.ensureUploaded('demo');

  await fetch(`${server.url}/centraid/demo/_chat`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: 'w1', message: 'hi' }),
  }).then((r) => r.text());

  await fs.rm(codeDir, { recursive: true, force: true });
  assert.match(seenPrompt, /addNote/, 'the declared action should appear in the catalog');
  assert.match(seenPrompt, /listNotes/, 'the declared query should appear in the catalog');
  assert.doesNotMatch(
    seenPrompt,
    /manifest unavailable/,
    'the override-resolved manifest must populate the catalog (regression: #137 git-store)',
  );
});

beforeEach(() => {
  // Ensure leftover state from a previous test doesn't bleed in.
  workspace = '';
});
