/*
 * Centraid chat-history store.
 *
 * A single shared SQLite database — `<stateDir>/centraid-chat-history.sqlite` —
 * holds every app's chat sessions in two tables. We deliberately use ONE file
 * (not one-per-app) because chat history is metadata, not app data: it stays
 * out of each app's user-facing `data.sqlite` and isn't reachable from the
 * agent's centraid_sql_* tools.
 *
 * Exposed over HTTP at the `/_centraid-chat` prefix. Two host surfaces
 * mount it identically:
 *   - the OpenClaw plugin (remote gateway) via `api.registerHttpRoute`
 *   - the embedded local runtime (`startRuntimeHttpServer`) intercepts the
 *     same prefix before delegating to `Runtime.handle`
 * Both surfaces share the schema and file layout so the same on-disk DB
 * file works regardless of how the desktop is configured.
 *
 * The desktop main process is the only client; auth is the same bearer
 * token the surrounding HTTP server already enforces.
 *
 * Persistence model:
 *   chat_sessions(id, app_id, title, created_at, updated_at)
 *   chat_messages(session_id, idx, payload_json, created_at)
 *
 * `payload_json` is whatever the renderer's `AppChatMsg` shape is. The plugin
 * doesn't interpret it (beyond peeking inside the first user message to
 * derive a title) — that keeps the schema stable as we evolve the chat UI.
 *
 * Schema changes are applied through the `MIGRATIONS` ladder below — append
 * a new entry, never edit a shipped one. See the comment on `MIGRATIONS`.
 *
 * Append is batched and transactional: one POST carries the full ordered
 * tail of a turn, and the server assigns idx values atomically. This is the
 * only way to preserve ordering across N parallel fire-and-forget posts.
 */

import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ChatSessionMeta {
  id: string;
  appId: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface ChatMessageRow {
  idx: number;
  payload: unknown;
  createdAt: number;
}

export interface AppendBatchResult {
  firstIdx: number;
  count: number;
  /** Canonical title after the append — may have just been derived. */
  title: string;
}

/**
 * Schema migrations for the chat-history DB.
 *
 * Each entry is the SQL to advance the DB from version `i` to `i+1`, applied
 * in order inside a single transaction. We track the applied version in
 * `PRAGMA user_version` (a free integer slot in the SQLite header) — a fresh
 * DB starts at 0, and every shipped build runs the pending tail on open.
 *
 * MIGRATIONS[0] is the baseline schema. It uses `IF NOT EXISTS` so it is
 * also safe to apply to DBs that pre-date version tracking — those open with
 * `user_version=0` but already have the tables; the statements no-op and we
 * advance to version 1.
 *
 * Hard rule: once a slot has shipped, its SQL is never edited. Fix-forward
 * by appending a new entry to the array.
 */
export const MIGRATIONS: readonly string[] = [
  // 0 → 1: baseline schema (chat_sessions, chat_messages, their indexes).
  `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      app_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_app_updated
      ON chat_sessions(app_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS chat_messages (
      session_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, idx),
      FOREIGN KEY (session_id) REFERENCES chat_sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_messages_session
      ON chat_messages(session_id);
  `,
];

function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  const current = row?.user_version ?? 0;

  // Downgrade guard: the DB has been advanced by a newer build than this one.
  // Refusing to open is strictly safer than running queries against a schema
  // we don't understand — the caller can surface this to the user.
  if (current > MIGRATIONS.length) {
    throw new Error(
      `chat-history DB is at version ${current} but this build only supports up to ${MIGRATIONS.length}. ` +
        `Please update centraid before opening this database.`,
    );
  }
  if (current === MIGRATIONS.length) return;

  db.exec('BEGIN IMMEDIATE');
  try {
    for (let v = current; v < MIGRATIONS.length; v++) {
      db.exec(MIGRATIONS[v]!);
      // v is a loop index bounded by MIGRATIONS.length — never user input —
      // so it is safe to interpolate into the PRAGMA statement (which does
      // not accept bind parameters).
      db.exec(`PRAGMA user_version = ${v + 1}`);
    }
    db.exec('COMMIT');
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* transaction already aborted — nothing to roll back */
    }
    throw err;
  }
}

export class ChatHistoryStore {
  private db: DatabaseSync;
  // Cache prepared statements once. node:sqlite reuses them efficiently and
  // we avoid the per-call prepare overhead in hot append loops.
  private stmts: {
    list: StatementSync;
    insertSession: StatementSync;
    getSession: StatementSync;
    getMessages: StatementSync;
    rename: StatementSync;
    deleteSession: StatementSync;
    sessionExists: StatementSync;
    nextIdx: StatementSync;
    insertMessage: StatementSync;
    setTitle: StatementSync;
    touch: StatementSync;
    metaOnly: StatementSync;
  };

  constructor(dbPath: string) {
    this.db = new DatabaseSync(dbPath);
    // Pragmas must run outside any transaction (journal_mode in particular),
    // so they happen before migrate() opens its BEGIN IMMEDIATE block.
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
    `);
    migrate(this.db);
    this.stmts = {
      list: this.db.prepare(
        `SELECT s.id, s.app_id, s.title, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
         FROM chat_sessions s
         WHERE s.app_id = ?
         ORDER BY s.updated_at DESC`,
      ),
      insertSession: this.db.prepare(
        `INSERT INTO chat_sessions (id, app_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ),
      getSession: this.db.prepare(
        `SELECT id, app_id, title, created_at, updated_at FROM chat_sessions WHERE id = ?`,
      ),
      getMessages: this.db.prepare(
        `SELECT idx, payload_json, created_at FROM chat_messages
         WHERE session_id = ? ORDER BY idx ASC`,
      ),
      rename: this.db.prepare(`UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`),
      deleteSession: this.db.prepare(`DELETE FROM chat_sessions WHERE id = ?`),
      sessionExists: this.db.prepare(`SELECT title FROM chat_sessions WHERE id = ?`),
      nextIdx: this.db.prepare(
        `SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM chat_messages WHERE session_id = ?`,
      ),
      insertMessage: this.db.prepare(
        `INSERT INTO chat_messages (session_id, idx, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ),
      setTitle: this.db.prepare(`UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ?`),
      touch: this.db.prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ?`),
      metaOnly: this.db.prepare(
        `SELECT s.id, s.app_id, s.title, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
         FROM chat_sessions s WHERE s.id = ?`,
      ),
    };
  }

  listSessions(appId: string): ChatSessionMeta[] {
    const rows = this.stmts.list.all(appId) as Array<{
      id: string;
      app_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      msg_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      appId: r.app_id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: Number(r.msg_count),
    }));
  }

  createSession(appId: string, title: string = ''): ChatSessionMeta {
    const now = Date.now();
    const id = randomUUID();
    this.stmts.insertSession.run(id, appId, title, now, now);
    return { id, appId, title, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  getSession(id: string): (ChatSessionMeta & { messages: ChatMessageRow[] }) | undefined {
    const row = this.stmts.getSession.get(id) as
      | { id: string; app_id: string; title: string; created_at: number; updated_at: number }
      | undefined;
    if (!row) return undefined;
    const msgs = this.stmts.getMessages.all(id) as Array<{
      idx: number;
      payload_json: string;
      created_at: number;
    }>;
    const messages: ChatMessageRow[] = msgs.map((m) => ({
      idx: Number(m.idx),
      payload: JSON.parse(m.payload_json) as unknown,
      createdAt: m.created_at,
    }));
    return {
      id: row.id,
      appId: row.app_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: messages.length,
      messages,
    };
  }

  renameSession(id: string, title: string): ChatSessionMeta | undefined {
    const now = Date.now();
    const res = this.stmts.rename.run(title, now, id);
    if (Number(res.changes) === 0) return undefined;
    return this.metaOnly(id);
  }

  deleteSession(id: string): boolean {
    const res = this.stmts.deleteSession.run(id);
    return Number(res.changes) > 0;
  }

  /**
   * Append a batch of messages to a session in a single transaction.
   * Returns the assigned `firstIdx`, the count appended, and the session's
   * title after the append (auto-derived from the first user message if it
   * was previously empty). Returns `undefined` if the session doesn't exist.
   *
   * Batching is the contract that gives us ordering: callers send one POST
   * with the ordered tail of a turn, and the server is the only thing that
   * assigns idx values — so two POSTs racing produce stable, separable
   * batches rather than interleaved chaos.
   */
  appendMessages(sessionId: string, payloads: unknown[]): AppendBatchResult | undefined {
    const existing = this.stmts.sessionExists.get(sessionId) as { title: string } | undefined;
    if (!existing) return undefined;
    if (payloads.length === 0) {
      return { firstIdx: 0, count: 0, title: existing.title };
    }

    // node:sqlite has no `transaction()` helper, so we wrap explicitly.
    // BEGIN IMMEDIATE acquires the write lock up-front instead of upgrading
    // mid-statement, which prevents SQLITE_BUSY if two batch POSTs land at
    // the same instant on different connections.
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const nextRow = this.stmts.nextIdx.get(sessionId) as { next: number };
      const firstIdx = Number(nextRow.next);
      let title = existing.title;

      for (let i = 0; i < payloads.length; i++) {
        const idx = firstIdx + i;
        const payload = payloads[i];
        this.stmts.insertMessage.run(sessionId, idx, JSON.stringify(payload), now);
        if (idx === 0 && !title && isUserMessage(payload)) {
          title = deriveTitle(payload.text);
        }
      }

      if (title !== existing.title) {
        this.stmts.setTitle.run(title, now, sessionId);
      } else {
        this.stmts.touch.run(now, sessionId);
      }

      this.db.exec('COMMIT');
      return { firstIdx, count: payloads.length, title };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private metaOnly(id: string): ChatSessionMeta | undefined {
    const row = this.stmts.metaOnly.get(id) as
      | {
          id: string;
          app_id: string;
          title: string;
          created_at: number;
          updated_at: number;
          msg_count: number;
        }
      | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      appId: row.app_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: Number(row.msg_count),
    };
  }
}

export function isUserMessage(p: unknown): p is { kind: 'user'; text: string } {
  return (
    typeof p === 'object' &&
    p !== null &&
    (p as { kind?: unknown }).kind === 'user' &&
    typeof (p as { text?: unknown }).text === 'string'
  );
}

export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '';
  if (cleaned.length <= 60) return cleaned;
  return `${cleaned.slice(0, 57)}…`;
}

/* ---------- HTTP route handler ---------- */

const ROUTE_PREFIX = '/_centraid-chat';

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return undefined;
  return JSON.parse(text) as unknown;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text).toString(),
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { error: message });
}

/**
 * Build the chat-history HTTP route handler. The store is resolved lazily
 * via `getStore()` so the SQLite connection only opens in the gateway
 * process (route handlers don't fire in agent-worker contexts), avoiding
 * stray DB handles in subprocesses that never touch chat history.
 *
 * Dispatch map:
 *   GET    /_centraid-chat/sessions?appId=...           list
 *   POST   /_centraid-chat/sessions                     create  body: {appId, title?}
 *   GET    /_centraid-chat/sessions/<id>                load (with messages)
 *   PATCH  /_centraid-chat/sessions/<id>                rename  body: {title}
 *   DELETE /_centraid-chat/sessions/<id>                delete
 *   POST   /_centraid-chat/sessions/<id>/messages       batch append  body: {payloads: [...]}
 */
export function makeChatHistoryRouteHandler(getStore: () => ChatHistoryStore) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    if (!req.url || !req.url.startsWith(ROUTE_PREFIX)) return false;
    // Use a dummy host because IncomingMessage.url is path-only.
    const url = new URL(req.url, 'http://x');
    const sub = url.pathname.slice(ROUTE_PREFIX.length); // e.g. "/sessions/abc/messages"
    const method = (req.method ?? 'GET').toUpperCase();
    const store = getStore();

    try {
      if (sub === '/sessions' || sub === '/sessions/') {
        if (method === 'GET') {
          const appId = url.searchParams.get('appId');
          if (!appId) {
            sendError(res, 400, 'appId is required');
            return true;
          }
          sendJson(res, 200, { sessions: store.listSessions(appId) });
          return true;
        }
        if (method === 'POST') {
          const body = (await readJsonBody(req)) as { appId?: string; title?: string } | undefined;
          if (!body?.appId) {
            sendError(res, 400, 'appId is required');
            return true;
          }
          sendJson(res, 200, store.createSession(body.appId, body.title ?? ''));
          return true;
        }
        sendError(res, 405, 'method not allowed');
        return true;
      }

      // /sessions/<id> or /sessions/<id>/messages
      const m = sub.match(/^\/sessions\/([^/]+)(?:\/(messages))?\/?$/);
      if (m && m[1]) {
        const id = decodeURIComponent(m[1]);
        const tail = m[2];
        if (tail === 'messages') {
          if (method !== 'POST') {
            sendError(res, 405, 'method not allowed');
            return true;
          }
          const body = (await readJsonBody(req)) as { payloads?: unknown } | undefined;
          if (!Array.isArray(body?.payloads)) {
            sendError(res, 400, 'payloads must be an array');
            return true;
          }
          const result = store.appendMessages(id, body.payloads);
          if (!result) {
            sendError(res, 404, 'session not found');
            return true;
          }
          sendJson(res, 200, result);
          return true;
        }
        if (method === 'GET') {
          const full = store.getSession(id);
          if (!full) {
            sendError(res, 404, 'session not found');
            return true;
          }
          sendJson(res, 200, full);
          return true;
        }
        if (method === 'PATCH') {
          const body = (await readJsonBody(req)) as { title?: string } | undefined;
          const title = typeof body?.title === 'string' ? body.title : '';
          const updated = store.renameSession(id, title);
          if (!updated) {
            sendError(res, 404, 'session not found');
            return true;
          }
          sendJson(res, 200, updated);
          return true;
        }
        if (method === 'DELETE') {
          const ok = store.deleteSession(id);
          sendJson(res, ok ? 200 : 404, { ok });
          return true;
        }
      }

      sendError(res, 404, 'unknown chat-history route');
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendError(res, 500, msg);
      return true;
    }
  };
}
