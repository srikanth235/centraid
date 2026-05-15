/*
 * Centraid chat-history store.
 *
 * Wraps the shared gateway SQLite (see `gateway-db.ts`) to read/write the
 * `chat_sessions` and `chat_messages` tables. Sessions are scoped by the
 * gateway-side user UUID (`UserStore.getUserId`) and `app_id`; messages
 * are append-only with monotonic per-session `idx`.
 *
 * Exposed over HTTP at the `/_centraid-chat` prefix (dispatcher lives in
 * `chat-history-routes.ts`). Two host surfaces mount the route identically:
 *   - the OpenClaw plugin (remote gateway) via `api.registerHttpRoute`
 *   - the embedded local runtime (`startRuntimeHttpServer`) intercepts
 *     the same prefix before delegating to `Runtime.handle`
 *
 * The desktop main process is the only HTTP client; auth is the same
 * bearer token the surrounding HTTP server already enforces.
 *
 * Persistence model:
 *   chat_sessions(id, user_id FK→users, app_id, title, created_at, updated_at)
 *   chat_messages(session_id FK→chat_sessions, idx, payload_json, created_at)
 *
 * `payload_json` is whatever the renderer's `AppChatMsg` shape is. The
 * runtime doesn't interpret it (beyond peeking inside the first user
 * message to derive a title) — that keeps the schema stable as we evolve
 * the chat UI.
 *
 * Append is batched and transactional: one POST carries the full ordered
 * tail of a turn, and the server assigns idx values atomically. This is
 * the only way to preserve ordering across N parallel fire-and-forget
 * posts.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from './gateway-db.js';

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
 * Provides the gateway-side single user UUID. Wired to `UserStore.getUserId`
 * by both hosts. Called once per ChatHistoryStore method invocation that
 * needs the id — cheap because UserStore caches the row in memory after the
 * first lookup.
 */
export type UserIdProvider = () => string;

interface PreparedStatements {
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
}

export class ChatHistoryStore {
  private readonly dbProvider: DatabaseProvider;
  private readonly userIdProvider: UserIdProvider;
  // Both populated lazily on first method call — see `UserStore` for the
  // worker-subprocess rationale that justifies the lazy pattern across all
  // gateway-state stores.
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(dbProvider: DatabaseProvider, userIdProvider: UserIdProvider) {
    this.dbProvider = dbProvider;
    this.userIdProvider = userIdProvider;
  }

  private ensureReady(): { db: DatabaseSync; stmts: PreparedStatements } {
    if (this.db && this.stmts) return { db: this.db, stmts: this.stmts };
    const db = this.dbProvider();
    const stmts: PreparedStatements = {
      list: db.prepare(
        `SELECT s.id, s.user_id, s.app_id, s.title, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
         FROM chat_sessions s
         WHERE s.user_id = ? AND s.app_id = ?
         ORDER BY s.updated_at DESC`,
      ),
      insertSession: db.prepare(
        `INSERT INTO chat_sessions (id, user_id, app_id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ),
      getSession: db.prepare(
        `SELECT id, user_id, app_id, title, created_at, updated_at
         FROM chat_sessions WHERE id = ? AND user_id = ?`,
      ),
      getMessages: db.prepare(
        `SELECT idx, payload_json, created_at FROM chat_messages
         WHERE session_id = ? ORDER BY idx ASC`,
      ),
      rename: db.prepare(
        `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ),
      deleteSession: db.prepare(`DELETE FROM chat_sessions WHERE id = ? AND user_id = ?`),
      sessionExists: db.prepare(`SELECT title FROM chat_sessions WHERE id = ? AND user_id = ?`),
      nextIdx: db.prepare(
        `SELECT COALESCE(MAX(idx) + 1, 0) AS next FROM chat_messages WHERE session_id = ?`,
      ),
      insertMessage: db.prepare(
        `INSERT INTO chat_messages (session_id, idx, payload_json, created_at)
         VALUES (?, ?, ?, ?)`,
      ),
      setTitle: db.prepare(
        `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
      ),
      touch: db.prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND user_id = ?`),
      metaOnly: db.prepare(
        `SELECT s.id, s.user_id, s.app_id, s.title, s.created_at, s.updated_at,
                (SELECT COUNT(*) FROM chat_messages m WHERE m.session_id = s.id) AS msg_count
         FROM chat_sessions s WHERE s.id = ? AND s.user_id = ?`,
      ),
    };
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  /** Resolve the current user UUID for scoping reads + writes. */
  private currentUserId(): string {
    return this.userIdProvider();
  }

  listSessions(appId: string): ChatSessionMeta[] {
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const rows = stmts.list.all(userId, appId) as Array<{
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
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const now = Date.now();
    const id = randomUUID();
    stmts.insertSession.run(id, userId, appId, title, now, now);
    return { id, userId, appId, title, createdAt: now, updatedAt: now, messageCount: 0 };
  }

  getSession(id: string): (ChatSessionMeta & { messages: ChatMessageRow[] }) | undefined {
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const row = stmts.getSession.get(id, userId) as
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
    const msgs = stmts.getMessages.all(id) as Array<{
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
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const now = Date.now();
    const res = stmts.rename.run(title, now, id, userId);
    if (Number(res.changes) === 0) return undefined;
    return this.metaOnly(id, userId);
  }

  deleteSession(id: string): boolean {
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const res = stmts.deleteSession.run(id, userId);
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
    const { db, stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const existing = stmts.sessionExists.get(sessionId, userId) as { title: string } | undefined;
    if (!existing) return undefined;
    if (payloads.length === 0) {
      return { firstIdx: 0, count: 0, title: existing.title };
    }

    // node:sqlite has no `transaction()` helper, so we wrap explicitly.
    // BEGIN IMMEDIATE acquires the write lock up-front instead of upgrading
    // mid-statement, which prevents SQLITE_BUSY if two batch POSTs land at
    // the same instant on different connections.
    db.exec('BEGIN IMMEDIATE');
    try {
      const now = Date.now();
      const nextRow = stmts.nextIdx.get(sessionId) as { next: number };
      const firstIdx = Number(nextRow.next);
      let title = existing.title;

      for (let i = 0; i < payloads.length; i++) {
        const idx = firstIdx + i;
        const payload = payloads[i];
        stmts.insertMessage.run(sessionId, idx, JSON.stringify(payload), now);
        if (idx === 0 && !title && isUserMessage(payload)) {
          title = deriveTitle(payload.text);
        }
      }

      if (title !== existing.title) {
        stmts.setTitle.run(title, now, sessionId, userId);
      } else {
        stmts.touch.run(now, sessionId, userId);
      }

      db.exec('COMMIT');
      return { firstIdx, count: payloads.length, title };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  private metaOnly(id: string, userId: string): ChatSessionMeta | undefined {
    const { stmts } = this.ensureReady();
    const row = stmts.metaOnly.get(id, userId) as
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
