import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { IncomingMessage, ServerResponse } from 'node:http';
import {
  ChatHistoryStore,
  MIGRATIONS,
  deriveTitle,
  isUserMessage,
  makeChatHistoryRouteHandler,
} from './chat-history.js';

function newStore(): ChatHistoryStore {
  // Each test gets its own DB file so cases stay isolated. Using a real path
  // (not :memory:) exercises the same code path as production — WAL pragmas
  // and FK constraints behave differently on in-memory DBs.
  const dir = mkdtempSync(join(tmpdir(), 'centraid-chat-history-'));
  return new ChatHistoryStore(join(dir, 'db.sqlite'));
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
    const s = store.createSession('todos', '');
    const list = store.listSessions('todos');
    assert.equal(list.length, 1);
    assert.equal(list[0]!.id, s.id);
    assert.equal(list[0]!.title, '');
    assert.equal(list[0]!.messageCount, 0);
  });

  it('listSessions is app-scoped', () => {
    store.createSession('todos', '');
    store.createSession('habits', '');
    const todos = store.listSessions('todos');
    const habits = store.listSessions('habits');
    assert.equal(todos.length, 1);
    assert.equal(habits.length, 1);
    assert.notEqual(todos[0]!.id, habits[0]!.id);
  });

  it('appendMessages assigns sequential idx from a single batch', () => {
    const s = store.createSession('todos');
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
    const s = store.createSession('todos');
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
    const s = store.createSession('todos', '');
    const r = store.appendMessages(s.id, [{ kind: 'user', text: 'Add a daily standup' }]);
    assert.equal(r?.title, 'Add a daily standup');
    const meta = store.listSessions('todos')[0]!;
    assert.equal(meta.title, 'Add a daily standup');
  });

  it('appendMessages does not overwrite a non-empty title', () => {
    const s = store.createSession('todos', 'Pinned name');
    const r = store.appendMessages(s.id, [{ kind: 'user', text: 'something' }]);
    assert.equal(r?.title, 'Pinned name');
  });

  it('appendMessages skips title derivation when first batch starts with non-user', () => {
    const s = store.createSession('todos', '');
    const r = store.appendMessages(s.id, [{ kind: 'ai', text: 'I went first' }]);
    assert.equal(r?.title, '');
  });

  it('appendMessages returns undefined for an unknown session', () => {
    const r = store.appendMessages('not-a-real-id', [{ kind: 'user', text: 'hi' }]);
    assert.equal(r, undefined);
  });

  it('appendMessages with empty array touches nothing', () => {
    const s = store.createSession('todos');
    const r = store.appendMessages(s.id, []);
    assert.equal(r?.count, 0);
    const loaded = store.getSession(s.id);
    assert.equal(loaded?.messages.length, 0);
  });

  it('renameSession updates title and bumps updatedAt', () => {
    const s = store.createSession('todos', 'old');
    const updated = store.renameSession(s.id, 'new');
    assert.equal(updated?.title, 'new');
    assert.ok((updated?.updatedAt ?? 0) >= s.updatedAt);
  });

  it('renameSession returns undefined for unknown id', () => {
    assert.equal(store.renameSession('nope', 'x'), undefined);
  });

  it('deleteSession cascades to messages', () => {
    const s = store.createSession('todos');
    store.appendMessages(s.id, [{ kind: 'user', text: 'doomed' }]);
    assert.equal(store.deleteSession(s.id), true);
    assert.equal(store.getSession(s.id), undefined);
  });

  it('listSessions orders by updatedAt desc', async () => {
    const a = store.createSession('todos', 'A');
    // Force a clock gap so the second session's createdAt > first's
    // updatedAt without us mutating the data.
    await new Promise((resolve) => setTimeout(resolve, 4));
    const b = store.createSession('todos', 'B');
    const list = store.listSessions('todos');
    assert.equal(list[0]!.id, b.id);
    assert.equal(list[1]!.id, a.id);
  });
});

describe('ChatHistoryStore migrations', () => {
  function freshDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), 'centraid-chat-history-mig-'));
    return join(dir, 'db.sqlite');
  }

  function readUserVersion(path: string): number {
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare('PRAGMA user_version').get() as { user_version: number };
      return row.user_version;
    } finally {
      db.close();
    }
  }

  it('advances user_version to MIGRATIONS.length on a fresh DB', () => {
    const path = freshDbPath();
    const store = new ChatHistoryStore(path);
    assert.ok(store);
    assert.equal(readUserVersion(path), MIGRATIONS.length);
  });

  it('re-opening an already-migrated DB is a no-op and preserves data', () => {
    const path = freshDbPath();
    const first = new ChatHistoryStore(path);
    const s = first.createSession('todos', 'kept');
    first.appendMessages(s.id, [{ kind: 'user', text: 'hello' }]);

    // Open a second handle to the same file. The constructor must accept the
    // already-migrated DB without error and see the prior data.
    const second = new ChatHistoryStore(path);
    const loaded = second.getSession(s.id);
    assert.equal(loaded?.title, 'kept');
    assert.equal(loaded?.messages.length, 1);
    assert.equal(readUserVersion(path), MIGRATIONS.length);
  });

  it('throws when DB is at a newer version than this build supports', () => {
    const path = freshDbPath();
    // Bootstrap the schema, then manually advance past the known ladder to
    // simulate an older build opening a DB written by a future centraid.
    const bootstrap = new ChatHistoryStore(path);
    assert.ok(bootstrap);
    const db = new DatabaseSync(path);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length + 1}`);
    db.close();

    assert.throws(() => new ChatHistoryStore(path), /newer|update centraid/i);
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

  it('400s on POST /sessions without appId', async () => {
    const res = await call(handler, 'POST', '/_centraid-chat/sessions', {});
    assert.equal(res.status, 400);
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
