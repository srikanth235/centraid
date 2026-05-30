/*
 * Schema-facing half of the chat store — the `chat_sessions` row shape,
 * its `ChatSessionMeta` mapping, and the prepared-statement set.
 *
 * Split out of `chat-history.ts` purely for file size: the store proper
 * (per-app resolution + the transcript fold) stays there. All scoping
 * still flows through the `user_id = ?` bind in every statement.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import type { ChatSessionMeta } from './chat-history.js';

export interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  adapter_kind: string | null;
  adapter_session_id: string | null;
  turn_count: number;
  created_at: number;
  updated_at: number;
  msg_count: number;
}

export function mapSessionRow(r: SessionRow): ChatSessionMeta {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    adapterKind: r.adapter_kind ?? null,
    adapterSessionId: r.adapter_session_id ?? null,
    turnCount: Number(r.turn_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    messageCount: Number(r.msg_count),
  };
}

// `msg_count` reconstructs the transcript length without materializing it:
// one user message per run + one node per run_node.
const SESSION_COLS = `s.id, s.user_id, s.title,
        s.adapter_kind, s.adapter_session_id, s.turn_count,
        s.created_at, s.updated_at,
        ((SELECT COUNT(*) FROM runs r WHERE r.chat_session_id = s.id)
         + (SELECT COUNT(*) FROM run_nodes n
            WHERE n.run_id IN (SELECT id FROM runs WHERE chat_session_id = s.id))
        ) AS msg_count`;

export interface ChatStatements {
  list: StatementSync;
  insertSession: StatementSync;
  getSession: StatementSync;
  rename: StatementSync;
  deleteSession: StatementSync;
  titleOf: StatementSync;
  setTitle: StatementSync;
  touch: StatementSync;
  noteTurnWithAdapter: StatementSync;
  noteTurnKindOnly: StatementSync;
  noteTurnNoAdapter: StatementSync;
}

/** Prepare the chat-store statement set against one app's `runtime.sqlite`. */
export function prepareChatStatements(db: DatabaseSync): ChatStatements {
  return {
    list: db.prepare(
      `SELECT ${SESSION_COLS}
       FROM chat_sessions s
       WHERE s.user_id = ?
       ORDER BY s.updated_at DESC`,
    ),
    insertSession: db.prepare(
      `INSERT INTO chat_sessions
         (id, user_id, title,
          adapter_kind, adapter_session_id, turn_count, created_at, updated_at)
       VALUES (?, ?, ?, NULL, NULL, 0, ?, ?)`,
    ),
    getSession: db.prepare(
      `SELECT ${SESSION_COLS}
       FROM chat_sessions s WHERE s.id = ? AND s.user_id = ?`,
    ),
    rename: db.prepare(
      `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ),
    deleteSession: db.prepare(`DELETE FROM chat_sessions WHERE id = ? AND user_id = ?`),
    titleOf: db.prepare(`SELECT title FROM chat_sessions WHERE id = ? AND user_id = ?`),
    setTitle: db.prepare(
      `UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?`,
    ),
    touch: db.prepare(`UPDATE chat_sessions SET updated_at = ? WHERE id = ? AND user_id = ?`),
    noteTurnWithAdapter: db.prepare(
      `UPDATE chat_sessions
       SET turn_count = turn_count + 1, updated_at = ?,
           adapter_kind = ?, adapter_session_id = ?
       WHERE id = ? AND user_id = ?`,
    ),
    noteTurnKindOnly: db.prepare(
      `UPDATE chat_sessions
       SET turn_count = turn_count + 1, updated_at = ?, adapter_kind = ?
       WHERE id = ? AND user_id = ?`,
    ),
    noteTurnNoAdapter: db.prepare(
      `UPDATE chat_sessions
       SET turn_count = turn_count + 1, updated_at = ?
       WHERE id = ? AND user_id = ?`,
    ),
  };
}
