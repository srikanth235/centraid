// governance: allow-repo-hygiene file-size-limit #181 — cohesive
// conversation-history suite; the build-kind coverage tips it just over 500
// lines, not worth a split.
import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { ConversationHistoryStore, deriveTitle, type RecordTurnInput } from './history.js';
import { makeConversationRouteHandler } from '../http/conversation-routes.js';
import { ConversationStore } from './store.js';
import { makeRuntimeDbProvider } from '../stores/gateway-db.js';

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

function newStore(provider: () => string = stubUserIdProvider): ConversationHistoryStore {
  return new ConversationHistoryStore(freshAppsDir(), provider);
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
    expect(deriveTitle('')).toBe('');
    expect(deriveTitle('   \n  ')).toBe('');
  });

  it('passes a short title through; collapses internal whitespace', () => {
    expect(deriveTitle('hello world')).toBe('hello world');
    expect(deriveTitle('a\n\n\nb')).toBe('a b');
  });

  it('truncates at 60 with ellipsis (collapsed first); leaves exactly-60 alone', () => {
    const long = 'word '.repeat(40); // 200 chars
    const t = deriveTitle(long);
    expect(t.length).toBe(58); // 57 + ellipsis
    expect(t.endsWith('…')).toBeTruthy();
    const sixty = 'a'.repeat(60);
    expect(deriveTitle(sixty)).toBe(sixty);
  });
});

describe('ConversationHistoryStore', () => {
  let store: ConversationHistoryStore;
  beforeEach(() => {
    store = newStore();
  });

  it('createSession + listSessions round-trips', () => {
    const s = store.createSession(APP, '');
    const list = store.listSessions(APP);
    expect(list.length).toBe(1);
    expect(list[0]!.id).toBe(s.id);
    expect(list[0]!.title).toBe('');
    expect(list[0]!.messageCount).toBe(0);
  });

  it('listSessions returns every session for the user in this app', () => {
    store.createSession(APP, 'one');
    store.createSession(APP, 'two');
    expect(store.listSessions(APP).length).toBe(2);
  });

  it('rejects an invalid app id', () => {
    expect(() => store.createSession('../escape')).toThrow(/invalid app id/i);
  });

  it('recordTurn folds a turn into a run and getSession reconstructs it', () => {
    const s = store.createSession(APP);
    const r = store.recordTurn(APP, turn(s.id, 'first', 'reply'));
    expect(r?.turnId).toBeTruthy();
    const loaded = store.getSession(APP, s.id);
    expect(loaded?.messages.length).toBe(2);
    expect(loaded?.messages.map((m) => m.idx)).toEqual([0, 1]);
    expect(loaded?.messages[0]!.payload).toEqual({ kind: 'user', text: 'first' });
    expect(loaded?.messages[1]!.payload).toEqual({ kind: 'ai', text: 'reply' });
  });

  it('recordTurn preserves order across multiple turns', () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, 'q1', 'a1', 1_000));
    store.recordTurn(APP, turn(s.id, 'q2', 'a2', 2_000));
    const loaded = store.getSession(APP, s.id);
    const texts = (loaded?.messages ?? []).map((m) => (m.payload as { text?: string }).text);
    expect(texts).toEqual(['q1', 'a1', 'q2', 'a2']);
  });

  it('recordTurn defaults the run kind to chat; honors an explicit build kind (#181)', () => {
    const appsDir = freshAppsDir();
    const local = new ConversationHistoryStore(appsDir, stubUserIdProvider);
    const chat = local.createSession(APP);
    const build = local.createSession(APP);
    local.recordTurn(APP, turn(chat.id, 'data q', 'data a', 1_000));
    local.recordTurn(APP, { ...turn(build.id, 'tweak ui', 'done', 2_000), kind: 'build' });

    // The kind moved UP onto the conversation (issue #190): a builder turn
    // sets its thread to `kind: 'build'`; a data chat stays `'chat'`. Read the
    // persisted conversations back through a fresh store on the same file.
    const conv = new ConversationStore(makeRuntimeDbProvider(join(appsDir, APP, 'runtime.sqlite')));
    expect(conv.getConversation(chat.id)?.kind).toBe('chat');
    expect(conv.getConversation(build.id)?.kind).toBe('build');

    // Transcript reconstruction is kind-agnostic — a build turn round-trips
    // exactly like a chat turn.
    const loaded = local.getSession(APP, build.id);
    expect(loaded?.messages[0]!.payload).toEqual({ kind: 'user', text: 'tweak ui' });
    expect(loaded?.messages[1]!.payload).toEqual({ kind: 'ai', text: 'done' });
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
    expect(loaded?.messages.length).toBe(3);
    const tool = loaded?.messages[1]!.payload as Record<string, unknown>;
    expect(tool.kind).toBe('tool');
    expect(tool.tool).toBe('centraid_sql_read');
    expect(tool.sql).toBe('SELECT COUNT(*) FROM x');
    expect(tool.state).toBe('ok');
    expect(tool.result).toEqual([{ n: 1 }]);
    expect(typeof tool.id).toBe('string');
    expect(loaded?.messages[2]!.payload).toEqual({ kind: 'ai', text: 'there is 1 row' });
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
    expect(tool.state).toBe('error');
    expect(tool.errorText).toBe('no such table');
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
    expect(ai).toEqual({ kind: 'ai', text: 'runner crashed', error: true });
  });

  it('recordTurn derives the title from the first user message if empty', () => {
    const s = store.createSession(APP, '');
    store.recordTurn(APP, turn(s.id, 'Add a daily standup', 'ok'));
    expect(store.listSessions(APP)[0]!.title).toBe('Add a daily standup');
  });

  it('recordTurn does not overwrite a non-empty title', () => {
    const s = store.createSession(APP, 'Pinned name');
    store.recordTurn(APP, turn(s.id, 'something', 'ok'));
    expect(store.getSessionMeta(APP, s.id)?.title).toBe('Pinned name');
  });

  it('recordTurn returns undefined for an unknown session', () => {
    expect(store.recordTurn(APP, turn('not-a-real-id', 'hi', 'x'))).toBe(undefined);
  });

  it('messageCount counts the reconstructed transcript length', () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, 'q', 'a'));
    expect(store.listSessions(APP)[0]!.messageCount).toBe(2);
    expect(store.getSessionMeta(APP, s.id)?.messageCount).toBe(2);
  });

  it('renameSession updates title and bumps updatedAt', () => {
    const s = store.createSession(APP, 'old');
    const updated = store.renameSession(APP, s.id, 'new');
    expect(updated?.title).toBe('new');
    expect((updated?.updatedAt ?? 0) >= s.updatedAt).toBeTruthy();
  });

  it('renameSession returns undefined for unknown id', () => {
    expect(store.renameSession(APP, 'nope', 'x')).toBe(undefined);
  });

  it('deleteSession cascades to the session runs', () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, 'doomed', 'x'));
    expect(store.deleteSession(APP, s.id)).toBe(true);
    expect(store.getSession(APP, s.id)).toBe(undefined);
  });

  it('listSessions orders by updatedAt desc', async () => {
    const a = store.createSession(APP, 'A');
    await new Promise((resolve) => setTimeout(resolve, 4));
    const b = store.createSession(APP, 'B');
    const list = store.listSessions(APP);
    expect(list[0]!.id).toBe(b.id);
    expect(list[1]!.id).toBe(a.id);
  });

  it('createSession persists and round-trips the row', () => {
    const s = store.createSession(APP, 'shell chat');
    expect(store.getSession(APP, s.id)?.title).toBe('shell chat');
  });

  it('noteTurn bumps turn_count and persists the adapter columns', () => {
    const s = store.createSession(APP);
    expect(s.turnCount).toBe(0);
    expect(s.adapterKind).toBe(null);

    const after1 = store.noteTurn(APP, s.id, { kind: 'codex', sessionId: 'cx-1' });
    expect(after1?.turnCount).toBe(1);
    expect(after1?.adapterKind).toBe('codex');
    expect(after1?.adapterSessionId).toBe('cx-1');

    // Adapter omitted — counters move, adapter columns stay.
    const after2 = store.noteTurn(APP, s.id);
    expect(after2?.turnCount).toBe(2);
    expect(after2?.adapterKind).toBe('codex');
    expect(after2?.adapterSessionId).toBe('cx-1');

    // Adapter present but no sessionId — kind updates, session id is kept.
    const after3 = store.noteTurn(APP, s.id, { kind: 'claude-code' });
    expect(after3?.turnCount).toBe(3);
    expect(after3?.adapterKind).toBe('claude-code');
    expect(after3?.adapterSessionId).toBe('cx-1');
  });

  it('noteTurn returns undefined for an unknown session', () => {
    expect(store.noteTurn(APP, 'not-a-real-id')).toBe(undefined);
  });

  it('getSessionMeta returns meta without the transcript', () => {
    const s = store.createSession(APP);
    store.recordTurn(APP, turn(s.id, 'hi', 'yo'));
    const meta = store.getSessionMeta(APP, s.id);
    expect(meta?.id).toBe(s.id);
    expect(meta?.messageCount).toBe(2);
    expect((meta as unknown as { messages?: unknown }).messages).toBe(undefined);
  });
});

describe('ConversationHistoryStore per-app scoping', () => {
  it('isolates sessions and lookups per app', () => {
    const store = new ConversationHistoryStore(freshAppsDir('todos', 'habits'), stubUserIdProvider);
    const t = store.createSession('todos', 'todos-1');
    store.createSession('habits', 'habits-1');
    store.createSession('habits', 'habits-2');
    expect(store.listSessions('todos').map((s) => s.title)).toEqual(['todos-1']);
    expect(store.listSessions('habits').length).toBe(2);
    // A session id is only found under its owning app.
    expect(store.getSession('todos', t.id)).toBeTruthy();
    expect(store.getSession('habits', t.id)).toBe(undefined);
  });
});

describe('ConversationHistoryStore per-user scoping', () => {
  // Two stores on the same app's runtime.sqlite, different user identities.
  function pair(): { alice: ConversationHistoryStore; bob: ConversationHistoryStore } {
    const appsDir = freshAppsDir();
    return {
      alice: new ConversationHistoryStore(appsDir, () => 'alice'),
      bob: new ConversationHistoryStore(appsDir, () => 'bob'),
    };
  }

  it('createSession stamps the current user id on the row', () => {
    const store = newStore(() => 'alice');
    const s = store.createSession(APP);
    expect(s.userId).toBe('alice');
    expect(store.getSession(APP, s.id)?.userId).toBe('alice');
  });

  it("listSessions does not return another user's sessions", () => {
    const { alice, bob } = pair();
    alice.createSession(APP, 'alice-1');
    alice.createSession(APP, 'alice-2');
    bob.createSession(APP, 'bob-1');

    const aliceList = alice.listSessions(APP);
    expect(aliceList.length).toBe(2);
    expect(aliceList.every((s) => s.userId === 'alice')).toBeTruthy();

    const bobList = bob.listSessions(APP);
    expect(bobList.length).toBe(1);
    expect(bobList[0]!.title).toBe('bob-1');
  });

  it("getSession returns undefined for another user's session id", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP);
    expect(bob.getSession(APP, aliceSession.id)).toBe(undefined);
  });

  it("recordTurn refuses to write into another user's session", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP);
    expect(bob.recordTurn(APP, turn(aliceSession.id, 'hi', 'x'))).toBe(undefined);
    expect(alice.getSession(APP, aliceSession.id)?.messages.length).toBe(0);
  });

  it("renameSession + deleteSession can't touch another user's session", () => {
    const { alice, bob } = pair();
    const aliceSession = alice.createSession(APP, 'mine');
    expect(bob.renameSession(APP, aliceSession.id, 'stolen')).toBe(undefined);
    expect(bob.deleteSession(APP, aliceSession.id)).toBe(false);
    expect(alice.getSession(APP, aliceSession.id)?.title).toBe('mine');
  });
});

describe('ConversationHistoryStore data persistence', () => {
  it("a second ConversationHistoryStore on the same app sees the first one's writes", () => {
    const appsDir = freshAppsDir();
    const first = new ConversationHistoryStore(appsDir, stubUserIdProvider);
    const s = first.createSession(APP, 'kept');
    first.recordTurn(APP, turn(s.id, 'hello', 'world'));

    const second = new ConversationHistoryStore(appsDir, stubUserIdProvider);
    const loaded = second.getSession(APP, s.id);
    expect(loaded?.title).toBe('kept');
    expect(loaded?.messages.length).toBe(2);
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
  handler: ReturnType<typeof makeConversationRouteHandler>,
  method: string,
  url: string,
  body?: unknown,
): Promise<FakeRes> {
  const req = makeReq(method, url, body) as unknown as IncomingMessage;
  const res = makeRes();
  return handler(req, res as unknown as ServerResponse).then(() => res);
}

describe('makeConversationRouteHandler', () => {
  const BASE = `/_centraid-conversations/apps/${APP}/sessions`;
  let handler: ReturnType<typeof makeConversationRouteHandler>;
  let store: ConversationHistoryStore;
  beforeEach(() => {
    store = newStore();
    handler = makeConversationRouteHandler(() => store);
  });

  it('POST sessions creates a session', async () => {
    const res = await call(handler, 'POST', BASE, {});
    expect(res.status).toBe(200);
    expect((res.body as { id: string }).id.length > 0).toBe(true);
  });

  it('POST sessions honors the title', async () => {
    const res = await call(handler, 'POST', BASE, { title: 'named' });
    expect(res.status).toBe(200);
    expect((res.body as { title: string }).title).toBe('named');
  });

  it('round-trips create → list → load → rename → delete', async () => {
    const created = await call(handler, 'POST', BASE, { title: 'hi' });
    expect(created.status).toBe(200);
    const id = (created.body as { id: string }).id;

    const listed = await call(handler, 'GET', BASE);
    expect(listed.status).toBe(200);
    expect((listed.body as { sessions: unknown[] }).sessions.length).toBe(1);

    const loaded = await call(handler, 'GET', `${BASE}/${id}`);
    expect(loaded.status).toBe(200);
    expect((loaded.body as { messages: unknown[] }).messages).toEqual([]);

    const renamed = await call(handler, 'PATCH', `${BASE}/${id}`, { title: 'renamed' });
    expect(renamed.status).toBe(200);
    expect((renamed.body as { title: string }).title).toBe('renamed');

    const deleted = await call(handler, 'DELETE', `${BASE}/${id}`);
    expect(deleted.status).toBe(200);
    expect((deleted.body as { ok: boolean }).ok).toBe(true);
  });

  it('404s loading a missing session', async () => {
    const res = await call(handler, 'GET', `${BASE}/no-such-id`);
    expect(res.status).toBe(404);
  });

  it('405s on unsupported method', async () => {
    const res = await call(handler, 'PUT', BASE);
    expect(res.status).toBe(405);
  });

  it('404s on a malformed route (no /apps/<appId> segment)', async () => {
    const res = await call(handler, 'GET', '/_centraid-conversations/sessions');
    expect(res.status).toBe(404);
  });

  it('returns false (delegates) for URLs outside the prefix', async () => {
    const req = makeReq('GET', '/something-else') as unknown as IncomingMessage;
    const res = makeRes();
    const handled = await handler(req, res as unknown as ServerResponse);
    expect(handled).toBe(false);
    expect(res.status).toBe(0); // never wrote anything
  });
});
