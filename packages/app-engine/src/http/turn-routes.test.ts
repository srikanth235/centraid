// governance: allow-repo-hygiene file-size-limit (#408) one HTTP turn-routing suite sharing the same runtime and conversation-runner fixture; splitting would duplicate the protocol harness and its state assertions
import { afterEach, beforeEach, expect, test } from 'vitest';
import { promises as fs, mkdirSync, mkdtempSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { Runtime } from '../runtime.ts';
import { startRuntimeHttpServer, type RuntimeHttpServerHandle } from './http-server.ts';
import type { ConversationRunner } from '../conversation/runner.ts';
import { ConversationHistoryStore } from '../conversation/history.ts';
import { makeJournalDbProvider } from '../stores/gateway-db.ts';
import type { WorkspaceProvider } from '../stores/vault-workspace.ts';
import type { AskModelInfo, AskModelPrefs } from './turn-routes.ts';

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

/**
 * A real `ConversationHistoryStore` over a fresh temp vault dir — mirrors
 * how the gateway wires `Runtime.conversationHistoryStore` in production
 * (`packages/gateway/src/serve/build-gateway.ts`). Wiring one turns on the
 * `_turn` route's "the conversationId must be a real session" 404 guard
 * (`turn-routes.ts` line ~195) — off by default in the tests above, which
 * bootstrap without a store.
 */
function newHistoryStore(): ConversationHistoryStore {
  const dir = mkdtempSync(path.join(os.tmpdir(), `centraid-chat-history-${crypto.randomUUID()}-`));
  mkdirSync(path.join(dir, 'apps'), { recursive: true });
  // One cached journal provider for this dir (mirrors history.test.ts's
  // `journalFor`) — a fresh `makeJournalDbProvider` per `workspace()` call
  // opens a second handle onto the same sqlite file and the turn hangs.
  const journal = makeJournalDbProvider(path.join(dir, 'journal.db'));
  const workspace: WorkspaceProvider = () => ({
    vaultId: 'vault-test',
    ownerPartyId: 'test-user',
    appsDir: path.join(dir, 'apps'),
    journal,
    journalDbFile: path.join(dir, 'journal.db'),
    runnerSessionDir: path.join(dir, 'runner-sessions'),
  });
  return new ConversationHistoryStore(workspace);
}

async function bootstrapWithStore(opts: { runner?: ConversationRunner } = {}): Promise<{
  store: ConversationHistoryStore;
}> {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-routes-${crypto.randomUUID()}-`),
  );
  const store = newHistoryStore();
  runtime = new Runtime({
    appsDir: workspace,
    conversationRunner: opts.runner,
    conversationHistoryStore: store,
  });
  server = await startRuntimeHttpServer({ runtime });
  await runtime.bootstrap();
  return { store };
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

test(
  'POST /_turn 404s on a client-guessed conversationId when a conversationHistoryStore is ' +
    'wired (the kit Ask panel bug: it must not mint an id itself — see history.createSession)',
  async () => {
    const runner: ConversationRunner = { run: async () => undefined };
    await bootstrapWithStore({ runner });
    await registerApp('demo');
    const res = await fetch(`${server.url}/centraid/demo/_turn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      // A client-minted id (crypto.randomUUID(), never provisioned via
      // `/_centraid-conversations/apps/demo/sessions`) has no matching row.
      body: JSON.stringify({ conversationId: crypto.randomUUID(), message: 'hi' }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('not_found');
  },
);

test('POST /_turn threads retryOf so the transcript collapses into a retry pager (#420)', async () => {
  const runner: ConversationRunner = {
    async run(input) {
      input.onEvent({ type: 'final', text: `re: ${input.message}` });
    },
  };
  const { store } = await bootstrapWithStore({ runner });
  await registerApp('demo');
  const session = store.createSession('demo', '');
  const post = (body: unknown): Promise<Response> =>
    fetch(`${server.url}/centraid/demo/_turn`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  await (await post({ conversationId: session.id, message: 'why' })).text();
  const firstAi = store.getSession('demo', session.id)?.messages[1]!.payload as { turnId: string };
  // Regenerate: same prompt, pointing retryOf at the first answer's turn.
  await (
    await post({ conversationId: session.id, message: 'why', retryOf: firstAi.turnId })
  ).text();

  const loaded = store.getSession('demo', session.id);
  // The family collapses to one user + one ai row, with a 2-attempt pager.
  expect(loaded?.messages.length).toBe(2);
  const ai = loaded?.messages[1]!.payload as {
    retry?: { count: number; index: number; attempts: Array<{ turnId: string }> };
  };
  expect(ai.retry?.count).toBe(2);
  expect(ai.retry?.attempts[0]?.turnId).toBe(firstAi.turnId);
});

test('POST /_turn succeeds once the session is provisioned via createSession — the canonical flow', async () => {
  const runner: ConversationRunner = {
    async run(input) {
      input.onEvent({ type: 'final', text: 'ok' });
    },
  };
  const { store } = await bootstrapWithStore({ runner });
  await registerApp('demo');
  // Mirrors what the desktop's chat pane does (gateway-client-conversation.ts
  // `createConversation`) and what the kit Ask panel's driver must now do
  // too: mint the session server-side before ever POSTing a turn.
  const session = store.createSession('demo', '');
  const res = await fetch(`${server.url}/centraid/demo/_turn`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ conversationId: session.id, message: 'hi' }),
  });
  expect(res.status).toBe(200);
  const text = await res.text();
  expect(text).toMatch(/event: final/);
  expect(text).toMatch(/"text":"ok"/);
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

// ---------- Ask-model picker (GET/PUT /centraid/<appId>/_turn/model) ----------

/** An in-memory `AskModelPrefs` fake — mirrors the gateway's prefs-store + catalog wiring. */
function fakeAskModel(opts?: {
  runnerKind?: string;
  defaultModel?: string;
  catalog?: { id: string; label: string }[];
}): AskModelPrefs & { current: string | null } {
  const state = { current: null as string | null };
  return {
    get current() {
      return state.current;
    },
    set current(v: string | null) {
      state.current = v;
    },
    get: async (): Promise<AskModelInfo> => ({
      runnerKind: opts?.runnerKind ?? 'codex',
      ...(opts?.defaultModel ? { defaultModel: opts.defaultModel } : {}),
      current: state.current,
      catalog: opts?.catalog ?? [],
    }),
    set: async (model: string | null) => {
      state.current = model;
    },
  };
}

async function bootstrapWithAskModel(askModel: AskModelPrefs): Promise<void> {
  workspace = await fs.mkdtemp(
    path.join(os.tmpdir(), `centraid-chat-routes-${crypto.randomUUID()}-`),
  );
  runtime = new Runtime({ appsDir: workspace, askModel });
  server = await startRuntimeHttpServer({ runtime });
  await runtime.bootstrap();
}

test('GET /_turn/model 503s when no askModel is configured', async () => {
  await bootstrap();
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_turn/model`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(503);
  const body = (await res.json()) as { error: string };
  expect(body.error).toBe('no_model_prefs');
});

test('PUT /_turn/model 503s when no askModel is configured', async () => {
  await bootstrap();
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_turn/model`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5' }),
  });
  expect(res.status).toBe(503);
});

test('GET /_turn/model 404s for an unregistered app', async () => {
  await bootstrapWithAskModel(fakeAskModel());
  const res = await fetch(`${server.url}/centraid/ghost/_turn/model`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(404);
});

test('GET /_turn/model returns the picker state — no override means current: null', async () => {
  const askModel = fakeAskModel({
    runnerKind: 'codex',
    defaultModel: 'gpt-5.5',
    catalog: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini' },
    ],
  });
  await bootstrapWithAskModel(askModel);
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_turn/model`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as AskModelInfo;
  expect(body).toEqual({
    runnerKind: 'codex',
    defaultModel: 'gpt-5.5',
    current: null,
    catalog: [
      { id: 'gpt-5.5', label: 'GPT-5.5' },
      { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini' },
    ],
  });
});

test('PUT /_turn/model sets the override and GET reflects it', async () => {
  const askModel = fakeAskModel({ runnerKind: 'codex', defaultModel: 'gpt-5.5' });
  await bootstrapWithAskModel(askModel);
  await registerApp('demo');

  const putRes = await fetch(`${server.url}/centraid/demo/_turn/model`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-5.5-mini' }),
  });
  expect(putRes.status).toBe(200);
  const putBody = (await putRes.json()) as AskModelInfo;
  expect(putBody.current).toBe('gpt-5.5-mini');

  const getRes = await fetch(`${server.url}/centraid/demo/_turn/model`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });
  const getBody = (await getRes.json()) as AskModelInfo;
  expect(getBody.current).toBe('gpt-5.5-mini');
});

test('PUT /_turn/model with model: null clears the override back to default', async () => {
  const askModel = fakeAskModel({ runnerKind: 'codex', defaultModel: 'gpt-5.5' });
  askModel.current = 'gpt-5.5-mini'; // pre-existing override
  await bootstrapWithAskModel(askModel);
  await registerApp('demo');

  const res = await fetch(`${server.url}/centraid/demo/_turn/model`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: null }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as AskModelInfo;
  expect(body.current).toBeNull();
});

test('PUT /_turn/model with a non-string, non-null model returns 400', async () => {
  await bootstrapWithAskModel(fakeAskModel());
  await registerApp('demo');
  const res = await fetch(`${server.url}/centraid/demo/_turn/model`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${server.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: 42 }),
  });
  expect(res.status).toBe(400);
});

beforeEach(() => {
  // Ensure leftover state from a previous test doesn't bleed in.
  workspace = '';
});
