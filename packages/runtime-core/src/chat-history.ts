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

export interface ChatSessionMeta {
  id: string;
  /** Owner of the session — the gateway-side user UUID from `UserStore`. */
  userId: string;
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
 * Centraid is pre-1.0 — the baseline schema is allowed to absorb shape
 * changes until we ship a stable release. Once we promise data durability
 * we'll switch to the strict append-only contract: never edit a shipped
 * slot, fix-forward only.
 */
export const MIGRATIONS: readonly string[] = [
  // 0 → 1: baseline schema. Includes `chat_sessions.user_id` (every row is
  // owned by a gateway-side user UUID from `UserStore`) and the composite
  // index every read path uses.
  `
    CREATE TABLE IF NOT EXISTS chat_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_chat_sessions_user_app_updated
      ON chat_sessions(user_id, app_id, updated_at DESC);

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

/**
 * Provides the gateway-side single user UUID. Wired to `UserStore.getUserId`
 * by both hosts. Called once per ChatHistoryStore method invocation that
 * needs the id — cheap because UserStore caches the row in memory after the
 * first lookup.
 */
export type UserIdProvider = () => string;

export class ChatHistoryStore {
  private db: DatabaseSync;
  private readonly userIdProvider: UserIdProvider;
  // Cache prepared statements once. node:sqlite reuses them efficiently and
  // we avoid the per-call prepare overhead in hot append loops. Every read
  // path scopes by user_id; every write path inserts user_id.
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

  constructor(dbPath: string, userIdProvider: UserIdProvider) {
    this.db = new DatabaseSync(dbPath);
    this.userIdProvider = userIdProvider;
    // Pragmas must run outside any transaction (journal_mode in particular),
    // so they happen before migrate() opens its BEGIN IMMEDIATE block.
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
    `);
    migrate(this.db);
    this.stmts = {
      list: this.db.prepare(
        `SELECT s.id, s.user_id, s.app_id, s.title, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
         FROM chat_sessions s
         WHERE s.user_id = ? AND s.app_id = ?
         ORDER BY s.updated_at DESC`,
      ),
      insertSession: this.db.prepare(
        `INSERT INTO chat_sessions (id, user_id, app_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      getSession: this.db.prepare(
        `SELECT id, user_id, app_id, title, created_at, updated_at
         FROM chat_sessions WHERE id = ? AND user_id = ?`,
      ),
      getMessages: this.db.prepare(
        `SELECT idx, payload_json, created_at FROM chat_messages
         WHERE session_id = ? ORDER BY idx ASC`,
      ),
      rename: this.db.prepare(
        `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ),
      deleteSession: this.db.prepare(`DELETE FROM chat_sessions WHERE id = ? AND user_id = ?`),
      sessionExists: this.db.prepare(
        `SELECT title FROM chat_sessions WHERE id = ? AND user_id = ?`,
      ),
      nextIdx: this.db.prepare(
        `SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM chat_messages WHERE session_id = ?`,
      ),
      insertMessage: this.db.prepare(
        `INSERT INTO chat_messages (session_id, idx, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ),
      setTitle: this.db.prepare(
        `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ),
      touch: this.db.prepare(
        `UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND user_id = ?`,
      ),
      metaOnly: this.db.prepare(
        `SELECT s.id, s.user_id, s.app_id, s.title, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
         FROM chat_sessions s WHERE s.id = ? AND s.user_id = ?`,
      ),
    };
  }

  /** Resolve the current user UUID for scoping reads + writes. */
  private currentUserId(): string {
    return this.userIdProvider();
  }

  listSessions(appId: string): ChatSessionMeta[] {
    const userId = this.currentUserId();
    const rows = this.stmts.list.all(userId, appId) as Array<{
      id: string;
      user_id: string;
      app_id: string;
      title: string;
      created_at: number;
      updated_at: number;
      msg_count: number;
    }>;
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      appId: r.app_id,
      title: r.title,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      messageCount: Number(r.msg_count),
    }));
  }

  createSession(appId: string, title: string = ''): ChatSessionMeta {
    const userId = this.currentUserId();
    const now = Date.now();
    const id = randomUUID();
    this.stmts.insertSession.run(id, userId, appId, title, now, now);
    return { id, userId, appId, title, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  getSession(id: string): (ChatSessionMeta & { messages: ChatMessageRow[] }) | undefined {
    const userId = this.currentUserId();
    const row = this.stmts.getSession.get(id, userId) as
      | {
          id: string;
          user_id: string;
          app_id: string;
          title: string;
          created_at: number;
          updated_at: number;
        }
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
      userId: row.user_id,
      appId: row.app_id,
      title: row.title,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: messages.length,
      messages,
    };
  }

  renameSession(id: string, title: string): ChatSessionMeta | undefined {
    const userId = this.currentUserId();
    const now = Date.now();
    const res = this.stmts.rename.run(title, now, id, userId);
    if (Number(res.changes) === 0) return undefined;
    return this.metaOnly(id, userId);
  }

  deleteSession(id: string): boolean {
    const userId = this.currentUserId();
    const res = this.stmts.deleteSession.run(id, userId);
    return Number(res.changes) > 0;
  }

  /**
   * Append a batch of messages to a session in a single transaction.
   * Returns the assigned `firstIdx`, the count appended, and the session's
   * title after the append (auto-derived from the first user message if it
   * was previously empty). Returns `undefined` if the session doesn't exist
   * — or, importantly, if it exists but is owned by a different user, so
   * cross-user writes are silently impossible.
   *
   * Batching is the contract that gives us ordering: callers send one POST
   * with the ordered tail of a turn, and the server is the only thing that
   * assigns idx values — so two POSTs racing produce stable, separable
   * batches rather than interleaved chaos.
   */
  appendMessages(sessionId: string, payloads: unknown[]): AppendBatchResult | undefined {
    const userId = this.currentUserId();
    const existing = this.stmts.sessionExists.get(sessionId, userId) as
      | { title: string }
      | undefined;
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
        this.stmts.setTitle.run(title, now, sessionId, userId);
      } else {
        this.stmts.touch.run(now, sessionId, userId);
      }

      this.db.exec('COMMIT');
      return { firstIdx, count: payloads.length, title };
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  private metaOnly(id: string, userId: string): ChatSessionMeta | undefined {
    const row = this.stmts.metaOnly.get(id, userId) as
      | {
          id: string;
          user_id: string;
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
      userId: row.user_id,
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

// HTTP route dispatcher lives in chat-history-routes.ts to keep this file
// focused on schema + store. Re-exported below from the package index.
