// governance: allow-repo-hygiene file-size-limit #181 — cohesive chat-history
// suite; the build-kind coverage tips it just over 500 lines, not worth a split.
import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { ChatHistoryStore, deriveTitle, type RecordTurnInput } from './chat-history.js';
import { makeChatHistoryRouteHandler } from './chat-history-routes.js';
import { ConversationStore } from './conversation-store.js';
import { makeRuntimeDbProvider } from './gateway-db.js';

// Tests that don't care about cross-user isolation share this stub UUID.
const TEST_USER_ID = 'test-user-uuid-0000';
const stubUserIdProvider = () => TEST_USER_ID;

// Chat is app-scoped (issue #98): each method takes the owning `appId`,
// which resolves `<appsDir>/<appId>/runtime.sqlite`. Tests pre-create the
// app folder — SQLite creates the file, not the directory.
const APP = 'todos';

/** A fresh temp apps dir with the given app folders (default `APP`). */
function freshAppsDir(...appIds: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'centraid-chat-history-'));
  for (const id of appIds.length ? appIds : [APP]) {
    mkdirSync(join(dir, id), { recursive: true });
  }
  return dir;
}

function newStore(provider: () => string = stubUserIdProvider): ChatHistoryStore {
  return new ChatHistoryStore(freshAppsDir(), provider);
}

/** Build a minimal one-step chat turn for `recordTurn`. */
function turn(
  conversationId: string,
  userMessage: string,
  reply: string,
  startedAt: number = Date.now(),
): RecordTurnInput {
  return {
    conversationId,
    userMessage,
    startedAt,
    endedAt: startedAt + 10,
    ok: true,
    finalText: reply,
    nodes: [{ kind: 'step', text: reply, startedAt, endedAt: startedAt + 10 }],
  };
}

describe('deriveTitle', () => {
  it('returns empty for empty/whitespace input', () => {
    assert.equal(deriveTitle(''), '');
    assert.equal(deriveTitle('   \n  '), '');
  });

  it('passes a short title through; collapses internal whitespace', () => {
    assert.equal(deriveTitle('hello world'), 'hello world');
    assert.equal(deriveTitle('a\n\n\nb'), 'a b');
  });

  it('truncates at 60 with ellipsis (collapsed first); leaves exactly-60 alone', () => {
    const long = 'word '.repeat(40); // 200 chars
    const t = deriveTitle(long);
    assert.equal(t.length, 58); // 57 + ellipsis
    assert.ok(t.endsWith('…'));
    const sixty = 'a'.repeat(60);
    assert.equal(deriveTitle(sixty), sixty);
  });
});

describe('ChatHistoryStore', () => {
  let store: ChatHistoryStore;
  beforeEach(() => {
    store = newStore();
  });

  it('createSession + listSessions round-trips', () => {
    const s = store.createSession(APP, '');
    const list = store.listSessions(APP);
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, s.id);
    assert.equal(list[0]!.title, '');
    assert.equal(list[0]!.messageCount, 0);
  });

  it('listSessions returns every session for the user in this app', () => {
    store.createSession(APP, 'one');
    store.createSession(APP, 'two');
    assert.equal(store.listSessions(APP).length, 2);
  });

  it('rejects an invalid app id', () => {
    assert.throws(() => store.createSession('../escape'), /invalid app id/i);
  });

  it('recordTurn folds a turn into a run and getSession reconstructs it', () => {
    const s = store.createSession(APP);
    const r = store.recordTurn(APP, turn(s.id, 'first', 'reply'));
    assert.ok(r?.turnId);
    const loaded = store.getSession(APP, s.id);
    assert.equal(loaded?.messages.length, 2);
    assert.deepEqual(
      loaded?.messages.map((m) => m.idx),
      [0, 1],
    );
    assert.deepEqual(loaded?.messages[0]!.payload, { kind: 'user', text: 'first' });
    assert.deepEqual(loaded?.messages[1]!.payload, { kind: 'ai', text: 'reply' });
  });

  it('recordTurn preserves order across multiple turns', () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, 'q1', 'a1', 1_000));
    store.recordTurn(APP, turn(s.id, 'q2', 'a2', 2_000));
    const loaded = store.getSession(APP, s.id);
    const texts = (loaded?.messages ?? []).map((m) => (m.payload as { text?: string }).text);
    assert.deepEqual(texts, ['q1', 'a1', 'q2', 'a2']);
  });

  it('recordTurn defaults the run kind to chat; honors an explicit build kind (#181)', () => {
    const appsDir = freshAppsDir();
    const local = new ChatHistoryStore(appsDir, stubUserIdProvider);
    const chat = local.createSession(APP);
    const build = local.createSession(APP);
    local.recordTurn(APP, turn(chat.id, 'data q', 'data a', 1_000));
    local.recordTurn(APP, { ...turn(build.id, 'tweak ui', 'done', 2_000), kind: 'build' });

    // The kind moved UP onto the conversation (issue #190): a builder turn
    // sets its thread to `kind: 'build'`; a data chat stays `'chat'`. Read the
    // persisted conversations back through a fresh store on the same file.
    const conv = new ConversationStore(makeRuntimeDbProvider(join(appsDir, APP, 'runtime.sqlite')));
    assert.equal(conv.getConversation(chat.id)?.kind, 'chat');
    assert.equal(conv.getConversation(build.id)?.kind, 'build');

    // Transcript reconstruction is kind-agnostic — a build turn round-trips
    // exactly like a chat turn.
    const loaded = local.getSession(APP, build.id);
    assert.deepEqual(loaded?.messages[0]!.payload, { kind: 'user', text: 'tweak ui' });
    assert.deepEqual(loaded?.messages[1]!.payload, { kind: 'ai', text: 'done' });
  });

  it('recordTurn reconstructs tool nodes interleaved before the assistant reply', () => {
    const s = store.createSession(APP);
    const t = 5_000;
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: 'count rows',
      startedAt: t,
      endedAt: t + 50,
      ok: true,
      finalText: 'there is 1 row',
      nodes: [
        {
          kind: 'tool',
          toolName: 'centraid_sql_read',
          sql: 'SELECT COUNT(*) FROM x',
          ok: true,
          result: [{ n: 1 }],
          appId: 'todos',
          startedAt: t,
          endedAt: t + 20,
        },
        { kind: 'step', text: 'there is 1 row', startedAt: t + 20, endedAt: t + 50 },
      ],
    });
    const loaded = store.getSession(APP, s.id);
    assert.equal(loaded?.messages.length, 3);
    const tool = loaded?.messages[1]!.payload as Record<string, unknown>;
    assert.equal(tool.kind, 'tool');
    assert.equal(tool.tool, 'centraid_sql_read');
    assert.equal(tool.sql, 'SELECT COUNT(*) FROM x');
    assert.equal(tool.state, 'ok');
    assert.deepEqual(tool.result, [{ n: 1 }]);
    assert.equal(typeof tool.id, 'string');
    assert.deepEqual(loaded?.messages[2]!.payload, { kind: 'ai', text: 'there is 1 row' });
  });

  it('recordTurn marks a failed tool node as state=error', () => {
    const s = store.createSession(APP);
    const t = 6_000;
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: 'break it',
      startedAt: t,
      endedAt: t + 30,
      ok: true,
      nodes: [
        {
          kind: 'tool',
          toolName: 'centraid_sql_write',
          ok: false,
          errorText: 'no such table',
          startedAt: t,
          endedAt: t + 30,
        },
      ],
    });
    const tool = store.getSession(APP, s.id)?.messages[1]!.payload as Record<string, unknown>;
    assert.equal(tool.state, 'error');
    assert.equal(tool.errorText, 'no such table');
  });

  it('recordTurn folds a turn error as an error ai message', () => {
    const s = store.createSession(APP);
    const t = 7_000;
    store.recordTurn(APP, {
      conversationId: s.id,
      userMessage: 'go',
      startedAt: t,
      endedAt: t + 5,
      ok: false,
      error: 'runner crashed',
      nodes: [
        { kind: 'step', text: 'runner crashed', isError: true, startedAt: t, endedAt: t + 5 },
      ],
    });
    const ai = store.getSession(APP, s.id)?.messages[1]!.payload as Record<string, unknown>;
    assert.deepEqual(ai, { kind: 'ai', text: 'runner crashed', error: true });
  });

  it('recordTurn derives the title from the first user message if empty', () => {
    const s = store.createSession(APP, '');
    store.recordTurn(APP, turn(s.id, 'Add a daily standup', 'ok'));
    assert.equal(store.listSessions(APP)[0]!.title, 'Add a daily standup');
  });

  it('recordTurn does not overwrite a non-empty title', () => {
    const s = store.createSession(APP, 'Pinned name');
    store.recordTurn(APP, turn(s.id, 'something', 'ok'));
    assert.equal(store.getSessionMeta(APP, s.id)?.title, 'Pinned name');
  });

  it('recordTurn returns undefined for an unknown session', () => {
    assert.equal(store.recordTurn(APP, turn('not-a-real-id', 'hi', 'x')), undefined);
  });

  it('messageCount counts the reconstructed transcript length', () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, 'q', 'a'));
    assert.equal(store.listSessions(APP)[0]!.messageCount, 2);
    assert.equal(store.getSessionMeta(APP, s.id)?.messageCount, 2);
  });

  it('renameSession updates title and bumps updatedAt', () => {
    const s = store.createSession(APP, 'old');
    const updated = store.renameSession(APP, s.id, 'new');
    assert.equal(updated?.title, 'new');
    assert.ok((updated?.updatedAt ?? 0) >= s.updatedAt);
  });

  it('renameSession returns undefined for unknown id', () => {
    assert.equal(store.renameSession(APP, 'nope', 'x'), undefined);
  });

  it('deleteSession cascades to the session runs', () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, 'doomed', 'x'));
    assert.equal(store.deleteSession(APP, s.id), true);
    assert.equal(store.getSession(APP, s.id), undefined);
  });

  it('listSessions orders by updatedAt desc', async () => {
    const a = store.createSession(APP, 'A');
    await new Promise((resolve) => setTimeout(resolve, 4));
    const b = store.createSession(APP, 'B');
    const list = store.listSessions(APP);
    assert.equal(list[0]!.id, b.id);
    assert.equal(list[1]!.id, a.id);
  });

  it('createSession persists and round-trips the row', () => {
    const s = store.createSession(APP, 'shell chat');
    assert.equal(store.getSession(APP, s.id)?.title, 'shell chat');
  });

  it('noteTurn bumps turn_count and persists the adapter columns', () => {
    const s = store.createSession(APP);
    assert.equal(s.turnCount, 0);
    assert.equal(s.adapterKind, null);

    const after1 = store.noteTurn(APP, s.id, { kind: 'codex', sessionId: 'cx-1' });
    assert.equal(after1?.turnCount, 1);
    assert.equal(after1?.adapterKind, 'codex');
    assert.equal(after1?.adapterSessionId, 'cx-1');

    // Adapter omitted — counters move, adapter columns stay.
    const after2 = store.noteTurn(APP, s.id);
    assert.equal(after2?.turnCount, 2);
    assert.equal(after2?.adapterKind, 'codex');
    assert.equal(after2?.adapterSessionId, 'cx-1');

    // Adapter present but no sessionId — kind updates, session id is kept.
    const after3 = store.noteTurn(APP, s.id, { kind: 'claude-code' });
    assert.equal(after3?.turnCount, 3);
    assert.equal(after3?.adapterKind, 'claude-code');
    assert.equal(after3?.adapterSessionId, 'cx-1');
  });

  it('noteTurn returns undefined for an unknown session', () => {
    assert.equal(store.noteTurn(APP, 'not-a-real-id'), undefined);
  });

  it('getSessionMeta returns meta without the transcript', () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, 'hi', 'yo'));
    const meta = store.getSessionMeta(APP, s.id);
    assert.equal(meta?.id, s.id);
    assert.equal(meta?.messageCount, 2);
    assert.equal((meta as unknown as { messages?: unknown }).messages, undefined);
  });
});

describe('ChatHistoryStore per-app scoping', () => {
  it('isolates sessions and lookups per app', () => {
    const store = new ChatHistoryStore(freshAppsDir('todos', 'habits'), stubUserIdProvider);
    const t = store.createSession('todos', 'todos-1');
    store.createSession('habits', 'habits-1');
    store.createSession('habits', 'habits-2');
    assert.deepEqual(
      store.listSessions('todos').map((s) => s.title),
      ['todos-1'],
    );
    assert.equal(store.listSessions('habits').length, 2);
    // A session id is only found under its owning app.
    assert.ok(store.getSession('todos', t.id));
    assert.equal(store.getSession('habits', t.id), undefined);
  });
});

describe('ChatHistoryStore per-user scoping', () => {
  // Two stores on the same app's runtime.sqlite, different user identities.
  function pair(): { alice: ChatHistoryStore; bob: ChatHistoryStore } {
    const appsDir = freshAppsDir();
    return {
      alice: new ChatHistoryStore(appsDir, () => 'alice'),
      bob: new ChatHistoryStore(appsDir, () => 'bob'),
    };
  }

  it('createSession stamps the current user id on the row', () => {
    const store = newStore(() => 'alice');
    const s = store.createSession(APP);
    assert.equal(s.userId, 'alice');
    assert.equal(store.getSession(APP, s.id)?.userId, 'alice');
  });

  it("listSessions does not return another user's sessions", () => {
    const { alice, bob } = pair();
    alice.createSession(APP, 'alice-1');
    alice.createSession(APP, 'alice-2');
    bob.createSession(APP, 'bob-1');

    const aliceList = alice.listSessions(APP);
    assert.equal(aliceList.length, 2);
    assert.ok(aliceList.every((s) => s.userId === 'alice'));

    const bobList = bob.listSessions(APP);
    assert.equal(bobList.length, 1);
    assert.equal(bobList[0]!.title, 'bob-1');
  });

  it("getSession returns undefined for another user's session id", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP);
    assert.equal(bob.getSession(APP, aliceSession.id), undefined);
  });

  it("recordTurn refuses to write into another user's session", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP);
    assert.equal(bob.recordTurn(APP, turn(aliceSession.id, 'hi', 'x')), undefined);
    assert.equal(alice.getSession(APP, aliceSession.id)?.messages.length, 0);
  });

  it("renameSession + deleteSession can't touch another user's session", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP, 'mine');
    assert.equal(bob.renameSession(APP, aliceSession.id, 'stolen'), undefined);
    assert.equal(bob.deleteSession(APP, aliceSession.id), false);
    assert.equal(alice.getSession(APP, aliceSession.id)?.title, 'mine');
  });
});

describe('ChatHistoryStore data persistence', () => {
  it("a second ChatHistoryStore on the same app sees the first one's writes", () => {
    const appsDir = freshAppsDir();
    const first = new ChatHistoryStore(appsDir, stubUserIdProvider);
    const s = first.createSession(APP, 'kept');
    first.recordTurn(APP, turn(s.id, 'hello', 'world'));

    const second = new ChatHistoryStore(appsDir, stubUserIdProvider);
    const loaded = second.getSession(APP, s.id);
    assert.equal(loaded?.title, 'kept');
    assert.equal(loaded?.messages.length, 2);
  });
});

// HTTP route dispatcher — minimal fake req/res, no real port bound.
interface FakeReq {
  url: string;
  method: string;
  [Symbol.asyncIterator](): AsyncIterableIterator<Buffer>;
}
interface FakeRes {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  writeHead(status: number, headers: Record<string, string>): FakeRes;
  end(text?: string): void;
  readonly body: unknown;
}

function makeReq(method: string, url: string, body?: unknown): FakeReq {
  const bodyJson = body === undefined ? undefined : JSON.stringify(body);
  return {
    method,
    url,
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Buffer> {
      if (bodyJson !== undefined) yield Buffer.from(bodyJson, 'utf8');
    },
  };
}

function makeRes(): FakeRes {
  const res: FakeRes = {
    status: 0,
    headers: {},
    bodyText: '',
    writeHead(status, headers): FakeRes {
      res.status = status;
      res.headers = headers;
      return res;
    },
    end(text?: string): void {
      if (text) res.bodyText = text;
    },
    get body(): unknown {
      return res.bodyText ? (JSON.parse(res.bodyText) as unknown) : null;
    },
  };
  return res;
}

function call(
  handler: ReturnType<typeof makeChatHistoryRouteHandler>,
  method: string,
  url: string,
  body?: unknown,
): Promise<FakeRes> {
  const req = makeReq(method, url, body) as unknown as IncomingMessage;
  const res = makeRes();
  return handler(req, res as unknown as ServerResponse).then(() => res);
}

describe('makeChatHistoryRouteHandler', () => {
  const BASE = `/_centraid-chat/apps/${APP}/sessions`;
  let handler: ReturnType<typeof makeChatHistoryRouteHandler>;
  let store: ChatHistoryStore;
  beforeEach(() => {
    store = newStore();
    handler = makeChatHistoryRouteHandler(() => store);
  });

  it('POST sessions creates a session', async () => {
    const res = await call(handler, 'POST', BASE, {});
    assert.equal(res.status, 200);
    assert.equal((res.body as { id: string }).id.length > 0, true);
  });

  it('POST sessions honors the title', async () => {
    const res = await call(handler, 'POST', BASE, { title: 'named' });
    assert.equal(res.status, 200);
    assert.equal((res.body as { title: string }).title, 'named');
  });

  it('round-trips create → list → load → rename → delete', async () => {
    const created = await call(handler, 'POST', BASE, { title: 'hi' });
    assert.equal(created.status, 200);
    const id = (created.body as { id: string }).id;

    const listed = await call(handler, 'GET', BASE);
    assert.equal(listed.status, 200);
    assert.equal((listed.body as { sessions: unknown[] }).sessions.length, 1);

    const loaded = await call(handler, 'GET', `${BASE}/${id}`);
    assert.equal(loaded.status, 200);
    assert.deepEqual((loaded.body as { messages: unknown[] }).messages, []);

    const renamed = await call(handler, 'PATCH', `${BASE}/${id}`, { title: 'renamed' });
    assert.equal(renamed.status, 200);
    assert.equal((renamed.body as { title: string }).title, 'renamed');

    const deleted = await call(handler, 'DELETE', `${BASE}/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal((deleted.body as { ok: boolean }).ok, true);
  });

  it('404s loading a missing session', async () => {
    const res = await call(handler, 'GET', `${BASE}/no-such-id`);
    assert.equal(res.status, 404);
  });

  it('405s on unsupported method', async () => {
    const res = await call(handler, 'PUT', BASE);
    assert.equal(res.status, 405);
  });

  it('404s on a malformed route (no /apps/<appId> segment)', async () => {
    const res = await call(handler, 'GET', '/_centraid-chat/sessions');
    assert.equal(res.status, 404);
  });

  it('returns false (delegates) for URLs outside the prefix', async () => {
    const req = makeReq('GET', '/something-else') as unknown as IncomingMessage;
    const res = makeRes();
    const handled = await handler(req, res as unknown as ServerResponse);
    assert.equal(handled, false);
    assert.equal(res.status, 0); // never wrote anything
  });
});
