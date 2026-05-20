import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { ChatHistoryStore, deriveTitle, isUserMessage } from './chat-history.js';
import { makeChatHistoryRouteHandler } from './chat-history-routes.js';
import { type DatabaseProvider, makeGatewayDbProvider } from './gateway-db.js';

// Tests that don't care about cross-user isolation share this stub UUID.
const TEST_USER_ID = 'test-user-uuid-0000';
const stubUserIdProvider = () => TEST_USER_ID;

/**
 * Pre-insert each user id into the `users` table so the chat_sessions FK is
 * satisfied. Production wires this through `UserStore.getUserId`; the tests
 * skip that to keep IDs stable and named.
 */
function seedUsers(dbProvider: DatabaseProvider, ids: string[]): void {
  const db = dbProvider();
  const stmt = db.prepare(`INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)`);
  for (const id of ids) stmt.run(id, Date.now());
}

function newStore(provider: () => string = stubUserIdProvider): ChatHistoryStore {
  // Each test gets its own DB file so cases stay isolated. Using a real path
  // (not :memory:) exercises the same code path as production — WAL pragmas
  // and FK constraints behave differently on in-memory DBs.
  const dir = mkdtempSync(join(tmpdir(), 'centraid-chat-history-'));
  const dbProvider = makeGatewayDbProvider(join(dir, 'db.sqlite'));
  seedUsers(dbProvider, [provider()]);
  return new ChatHistoryStore(dbProvider, provider);
}

describe('deriveTitle', () => {
  it('returns empty for empty/whitespace input', () => {
    assert.equal(deriveTitle(''), '');
    assert.equal(deriveTitle('   \n  '), '');
  });

  it('passes through a short title', () => {
    assert.equal(deriveTitle('hello world'), 'hello world');
  });

  it('collapses internal whitespace before truncating', () => {
    // Without collapse, "a\n\n\nb" would be 4 chars; with collapse it's "a b".
    assert.equal(deriveTitle('a\n\n\nb'), 'a b');
  });

  it('truncates at 60 with ellipsis (collapsed first)', () => {
    const long = 'word '.repeat(40); // 200 chars
    const t = deriveTitle(long);
    assert.equal(t.length, 58); // 57 + ellipsis
    assert.ok(t.endsWith('…'));
  });

  it('does not truncate exactly-60-char input', () => {
    const sixty = 'a'.repeat(60);
    assert.equal(deriveTitle(sixty), sixty);
  });
});

describe('isUserMessage', () => {
  it('accepts the canonical user shape', () => {
    assert.equal(isUserMessage({ kind: 'user', text: 'hi' }), true);
  });

  it('rejects other kinds or missing text', () => {
    assert.equal(isUserMessage({ kind: 'ai', text: 'hi' }), false);
    assert.equal(isUserMessage({ kind: 'user' }), false);
    assert.equal(isUserMessage(null), false);
    assert.equal(isUserMessage('hi'), false);
  });
});

describe('ChatHistoryStore', () => {
  let store: ChatHistoryStore;
  beforeEach(() => {
    store = newStore();
  });

  it('createSession + listSessions round-trips', () => {
    const s = store.createSession('todos', 'full', '');
    const list = store.listSessions('todos');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, s.id);
    assert.equal(list[0]!.title, '');
    assert.equal(list[0]!.messageCount, 0);
  });

  it('listSessions is app-scoped', () => {
    store.createSession('todos', 'full', '');
    store.createSession('habits', '');
    const todos = store.listSessions('todos');
    const habits = store.listSessions('habits');
    assert.equal(todos.length, 1);
    assert.equal(habits.length, 1);
    assert.notEqual(todos[0]!.id, habits[0]!.id);
  });

  it('appendMessages assigns sequential idx from a single batch', () => {
    const s = store.createSession('todos', 'full');
    const r = store.appendMessages(s.id, [
      { kind: 'user', text: 'first' },
      { kind: 'ai', text: 'reply' },
      { kind: 'tool', id: 't1', tool: 'centraid_sql_read', state: 'ok' },
    ]);
    assert.equal(r?.firstIdx, 0);
    assert.equal(r?.count, 3);
    const loaded = store.getSession(s.id);
    assert.equal(loaded?.messages.length, 3);
    assert.deepEqual(
      loaded?.messages.map((m) => m.idx),
      [0, 1, 2],
    );
  });

  it('appendMessages preserves order across two sequential batches', () => {
    const s = store.createSession('todos', 'full');
    store.appendMessages(s.id, [
      { kind: 'user', text: 'q1' },
      { kind: 'ai', text: 'a1' },
    ]);
    store.appendMessages(s.id, [
      { kind: 'user', text: 'q2' },
      { kind: 'ai', text: 'a2' },
    ]);
    const loaded = store.getSession(s.id);
    const texts = (loaded?.messages ?? []).map((m) => (m.payload as { text?: string }).text);
    assert.deepEqual(texts, ['q1', 'a1', 'q2', 'a2']);
  });

  it('appendMessages derives title from the first user message if title is empty', () => {
    const s = store.createSession('todos', 'full', '');
    const r = store.appendMessages(s.id, [{ kind: 'user', text: 'Add a daily standup' }]);
    assert.equal(r?.title, 'Add a daily standup');
    const meta = store.listSessions('todos')[0]!;
    assert.equal(meta.title, 'Add a daily standup');
  });

  it('appendMessages does not overwrite a non-empty title', () => {
    const s = store.createSession('todos', 'full', 'Pinned name');
    const r = store.appendMessages(s.id, [{ kind: 'user', text: 'something' }]);
    assert.equal(r?.title, 'Pinned name');
  });

  it('appendMessages skips title derivation when first batch starts with non-user', () => {
    const s = store.createSession('todos', 'full', '');
    const r = store.appendMessages(s.id, [{ kind: 'ai', text: 'I went first' }]);
    assert.equal(r?.title, '');
  });

  it('appendMessages returns undefined for an unknown session', () => {
    const r = store.appendMessages('not-a-real-id', [{ kind: 'user', text: 'hi' }]);
    assert.equal(r, undefined);
  });

  it('appendMessages with empty array touches nothing', () => {
    const s = store.createSession('todos', 'full');
    const r = store.appendMessages(s.id, []);
    assert.equal(r?.count, 0);
    const loaded = store.getSession(s.id);
    assert.equal(loaded?.messages.length, 0);
  });

  it('renameSession updates title and bumps updatedAt', () => {
    const s = store.createSession('todos', 'full', 'old');
    const updated = store.renameSession(s.id, 'new');
    assert.equal(updated?.title, 'new');
    assert.ok((updated?.updatedAt ?? 0) >= s.updatedAt);
  });

  it('renameSession returns undefined for unknown id', () => {
    assert.equal(store.renameSession('nope', 'x'), undefined);
  });

  it('deleteSession cascades to messages', () => {
    const s = store.createSession('todos', 'full');
    store.appendMessages(s.id, [{ kind: 'user', text: 'doomed' }]);
    assert.equal(store.deleteSession(s.id), true);
    assert.equal(store.getSession(s.id), undefined);
  });

  it('listSessions orders by updatedAt desc', async () => {
    const a = store.createSession('todos', 'full', 'A');
    // Force a clock gap so the second session's createdAt > first's
    // updatedAt without us mutating the data.
    await new Promise((resolve) => setTimeout(resolve, 4));
    const b = store.createSession('todos', 'full', 'B');
    const list = store.listSessions('todos');
    assert.equal(list[0]!.id, b.id);
    assert.equal(list[1]!.id, a.id);
  });

  it('createSession with a null originAppId persists NULL and round-trips', () => {
    const s = store.createSession(null, 'data', 'shell chat');
    assert.equal(s.originAppId, null);
    assert.equal(s.mode, 'data');
    const loaded = store.getSession(s.id);
    assert.equal(loaded?.originAppId, null);
    assert.equal(loaded?.mode, 'data');
    // A null-origin session is not returned by any app-scoped listing.
    assert.equal(store.listSessions('todos').length, 0);
  });

  it('noteTurn bumps turn_count and persists the adapter columns', () => {
    const s = store.createSession('todos', 'full');
    assert.equal(s.turnCount, 0);
    assert.equal(s.adapterKind, null);

    const after1 = store.noteTurn(s.id, { kind: 'codex', sessionId: 'cx-1' });
    assert.equal(after1?.turnCount, 1);
    assert.equal(after1?.adapterKind, 'codex');
    assert.equal(after1?.adapterSessionId, 'cx-1');

    // Adapter omitted — counters move, adapter columns stay.
    const after2 = store.noteTurn(s.id);
    assert.equal(after2?.turnCount, 2);
    assert.equal(after2?.adapterKind, 'codex');
    assert.equal(after2?.adapterSessionId, 'cx-1');

    // Adapter present but no sessionId — kind updates, session id is kept.
    const after3 = store.noteTurn(s.id, { kind: 'claude-code' });
    assert.equal(after3?.turnCount, 3);
    assert.equal(after3?.adapterKind, 'claude-code');
    assert.equal(after3?.adapterSessionId, 'cx-1');
  });

  it('noteTurn returns undefined for an unknown session', () => {
    assert.equal(store.noteTurn('not-a-real-id'), undefined);
  });

  it('getSessionMeta returns meta without messages', () => {
    const s = store.createSession('todos', 'full');
    store.appendMessages(s.id, [{ kind: 'user', text: 'hi' }]);
    const meta = store.getSessionMeta(s.id);
    assert.equal(meta?.id, s.id);
    assert.equal(meta?.messageCount, 1);
    assert.equal((meta as unknown as { messages?: unknown }).messages, undefined);
  });
});

describe('ChatHistoryStore per-user scoping', () => {
  // Two stores backed by the same SQLite file but with different user
  // identities — simulates two devices syncing against the same gateway
  // sqlite (or a future multi-user model). Operations must be invisible
  // across users.
  function pair(): { alice: ChatHistoryStore; bob: ChatHistoryStore } {
    const dir = mkdtempSync(join(tmpdir(), 'centraid-chat-history-multi-'));
    // Both stores share the same gateway DB provider — same connection,
    // same on-disk file. Pre-seed both user rows so the chat_sessions FK
    // accepts inserts from either store.
    const dbProvider = makeGatewayDbProvider(join(dir, 'db.sqlite'));
    seedUsers(dbProvider, ['alice', 'bob']);
    return {
      alice: new ChatHistoryStore(dbProvider, () => 'alice'),
      bob: new ChatHistoryStore(dbProvider, () => 'bob'),
    };
  }

  it('createSession stamps the current user id on the row', () => {
    const store = newStore(() => 'alice');
    const s = store.createSession('todos', 'full');
    assert.equal(s.userId, 'alice');
    const loaded = store.getSession(s.id);
    assert.equal(loaded?.userId, 'alice');
  });

  it("listSessions does not return another user's sessions", () => {
    const { alice, bob } = pair();
    alice.createSession('todos', 'full', 'alice-1');
    alice.createSession('todos', 'full', 'alice-2');
    bob.createSession('todos', 'full', 'bob-1');

    const aliceList = alice.listSessions('todos');
    assert.equal(aliceList.length, 2);
    assert.ok(aliceList.every((s) => s.userId === 'alice'));

    const bobList = bob.listSessions('todos');
    assert.equal(bobList.length, 1);
    assert.equal(bobList[0]!.title, 'bob-1');
  });

  it("getSession returns undefined for another user's session id", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession('todos', 'full');
    // Bob asking for Alice's session id sees nothing — same id, different
    // owner. The PK is `id` so the row exists; the user_id filter rejects.
    assert.equal(bob.getSession(aliceSession.id), undefined);
  });

  it("appendMessages refuses to write into another user's session", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession('todos', 'full');
    const result = bob.appendMessages(aliceSession.id, [{ kind: 'user', text: 'hi' }]);
    assert.equal(result, undefined);
    // And Alice's session still has zero messages.
    const loaded = alice.getSession(aliceSession.id);
    assert.equal(loaded?.messages.length, 0);
  });

  it("renameSession + deleteSession can't touch another user's session", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession('todos', 'full', 'mine');
    assert.equal(bob.renameSession(aliceSession.id, 'stolen'), undefined);
    assert.equal(bob.deleteSession(aliceSession.id), false);
    // Alice's session is untouched.
    const loaded = alice.getSession(aliceSession.id);
    assert.equal(loaded?.title, 'mine');
  });
});

// Migration tests live in `gateway-db.test.ts` — the schema for sessions
// + messages + users + prefs is one ladder, so it's tested in one place.

describe('ChatHistoryStore data persistence', () => {
  it("a second ChatHistoryStore on the same DB sees the first one's writes", () => {
    const dir = mkdtempSync(join(tmpdir(), 'centraid-chat-history-persist-'));
    const dbProvider = makeGatewayDbProvider(join(dir, 'db.sqlite'));
    seedUsers(dbProvider, [TEST_USER_ID]);
    const first = new ChatHistoryStore(dbProvider, stubUserIdProvider);
    const s = first.createSession('todos', 'full', 'kept');
    first.appendMessages(s.id, [{ kind: 'user', text: 'hello' }]);

    const second = new ChatHistoryStore(dbProvider, stubUserIdProvider);
    const loaded = second.getSession(s.id);
    assert.equal(loaded?.title, 'kept');
    assert.equal(loaded?.messages.length, 1);
  });
});

/* ---------- HTTP route dispatcher ---------- */

// Minimal fake req/res that we can inspect without binding a real port.
// The route handler only touches: req.url, req.method, async-iterating req
// for the body; res.writeHead and res.end. We model both as plain objects
// (rather than classes) to stay under the lint rule that caps a file at
// one class — the existing ChatHistoryStore tests already use that slot.
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
  let handler: ReturnType<typeof makeChatHistoryRouteHandler>;
  let store: ChatHistoryStore;
  beforeEach(() => {
    store = newStore();
    handler = makeChatHistoryRouteHandler(() => store);
  });

  it('POST /sessions without appId creates a shell-origin session', async () => {
    const res = await call(handler, 'POST', '/_centraid-chat/sessions', {});
    assert.equal(res.status, 200);
    assert.equal((res.body as { originAppId: string | null }).originAppId, null);
    assert.equal((res.body as { mode: string }).mode, 'full');
  });

  it('POST /sessions honors the data mode', async () => {
    const res = await call(handler, 'POST', '/_centraid-chat/sessions', {
      appId: 'todos',
      mode: 'data',
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { mode: string }).mode, 'data');
    assert.equal((res.body as { originAppId: string | null }).originAppId, 'todos');
  });

  it('round-trips create → list → append → load → delete', async () => {
    const created = await call(handler, 'POST', '/_centraid-chat/sessions', {
      appId: 'todos',
    });
    assert.equal(created.status, 200);
    const id = (created.body as { id: string }).id;

    const listed = await call(handler, 'GET', '/_centraid-chat/sessions?appId=todos');
    assert.equal(listed.status, 200);
    assert.equal((listed.body as { sessions: unknown[] }).sessions.length, 1);

    const appended = await call(handler, 'POST', `/_centraid-chat/sessions/${id}/messages`, {
      payloads: [{ kind: 'user', text: 'hello' }],
    });
    assert.equal(appended.status, 200);
    assert.equal((appended.body as { title: string }).title, 'hello');

    const loaded = await call(handler, 'GET', `/_centraid-chat/sessions/${id}`);
    assert.equal(loaded.status, 200);
    assert.equal((loaded.body as { messages: unknown[] }).messages.length, 1);

    const deleted = await call(handler, 'DELETE', `/_centraid-chat/sessions/${id}`);
    assert.equal(deleted.status, 200);
    assert.equal((deleted.body as { ok: boolean }).ok, true);
  });

  it('400s on append with non-array payloads', async () => {
    const created = await call(handler, 'POST', '/_centraid-chat/sessions', {
      appId: 'todos',
    });
    const id = (created.body as { id: string }).id;
    const res = await call(handler, 'POST', `/_centraid-chat/sessions/${id}/messages`, {
      payloads: 'not-an-array',
    });
    assert.equal(res.status, 400);
  });

  it('404s on appending to a missing session', async () => {
    const res = await call(handler, 'POST', '/_centraid-chat/sessions/no-such-id/messages', {
      payloads: [{ kind: 'user', text: 'x' }],
    });
    assert.equal(res.status, 404);
  });

  it('405s on unsupported method', async () => {
    const res = await call(handler, 'PUT', '/_centraid-chat/sessions');
    assert.equal(res.status, 405);
  });

  it('returns false (delegates) for URLs outside the prefix', async () => {
    const req = makeReq('GET', '/something-else') as unknown as IncomingMessage;
    const res = makeRes();
    const handled = await handler(req, res as unknown as ServerResponse);
    assert.equal(handled, false);
    assert.equal(res.status, 0); // never wrote anything
  });
});
