/*
 * Centraid chat store — the conversation-container store + transcript fold.
 *
 * Wraps the activity SQLite (see `gateway-db.ts`) to read/write the
 * `chat_sessions` table. A chat session IS the chat window (the session
 * id is the window id); sessions are scoped by the gateway-side user
 * UUID (`UserStore.getUserId`). Chat is a flat per-user store — no
 * `origin_app_id`; the app a turn ran against is per-turn context only.
 *
 * The transcript is NOT its own table. A chat turn is a `runs` row
 * (`kind='chat'`, `trigger='interactive'`, `chat_session_id` FK) and the
 * turn's messages are `run_nodes` — assistant text as a `step` node, each
 * tool call as a `tool` node (issue #90 fold: `chat_messages` is gone).
 * `recordTurn` writes that trace; `getSession` reconstructs the renderer
 * transcript back out of it. Exposed over HTTP at `/_centraid-chat`
 * (dispatcher in `chat-history-routes.ts`), mounted identically by the
 * OpenClaw plugin and the embedded local runtime.
 */

import { type DatabaseSync, type StatementSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type { DatabaseProvider } from './gateway-db.js';
import { AutomationRunsStore } from './automation-runs-store.js';
import { costForUsage } from './model-pricing.js';
import {
  parseStepOutput,
  parseToolArgs,
  parseToolOutput,
  parseUserMessage,
} from './chat-transcript.js';

export interface ChatSessionMeta {
  id: string;
  /** Owner of the session — the gateway-side user UUID from `UserStore`. */
  userId: string;
  title: string;
  /** Sticky chat mode: `full` (agent + SQL tools) or `data` (SQL only). */
  mode: 'full' | 'data';
  /** Runner kind that owns `adapterSessionId` (codex | claude-code | openclaw). */
  adapterKind: string | null;
  /** Opaque per-runner resume handle; `null` until the first turn lands. */
  adapterSessionId: string | null;
  /** Number of completed turns on this session. */
  turnCount: number;
  createdAt: number;
  updatedAt: number;
  /** Reconstructed transcript length (user + assistant + tool messages). */
  messageCount: number;
}

export interface ChatMessageRow {
  idx: number;
  payload: unknown;
  createdAt: number;
}

/**
 * One node of a completed chat turn, handed to `recordTurn`. The chat
 * route accumulates these from the runner's `ChatStreamEvent`s.
 */
export type ChatTurnNode =
  | {
      kind: 'step';
      /** Accumulated assistant text for the turn. */
      text: string;
      /** True when this step carries a runner/turn error message. */
      isError?: boolean;
      /** The model + provider that served the turn, when the runner reports it. */
      model?: string;
      provider?: string;
      /** Per-turn token usage from the runner's `usage` event, when reported. */
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      startedAt: number;
      endedAt: number;
    }
  | {
      kind: 'tool';
      toolName: string;
      /** SQL surfaced separately for `centraid_sql_*` tools. */
      sql?: string;
      args?: unknown;
      ok: boolean;
      result?: unknown;
      errorText?: string;
      /** App whose data the tool call touched (per-turn context). */
      appId?: string;
      startedAt: number;
      endedAt: number;
    };

export interface RecordTurnInput {
  chatSessionId: string;
  /** The user's prompt for the turn — stored as the run's `input_json`. */
  userMessage: string;
  startedAt: number;
  endedAt: number;
  ok: boolean;
  error?: string;
  /** The assistant's final reply text (the run's `output_json`). */
  finalText?: string;
  /** The turn's ordered trace. */
  nodes: ChatTurnNode[];
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
  rename: StatementSync;
  deleteSession: StatementSync;
  titleOf: StatementSync;
  setTitle: StatementSync;
  touch: StatementSync;
  noteTurnWithAdapter: StatementSync;
  noteTurnKindOnly: StatementSync;
  noteTurnNoAdapter: StatementSync;
}

interface SessionRow {
  id: string;
  user_id: string;
  title: string;
  mode: string;
  adapter_kind: string | null;
  adapter_session_id: string | null;
  turn_count: number;
  created_at: number;
  updated_at: number;
  msg_count: number;
}

function mapSessionRow(r: SessionRow): ChatSessionMeta {
  return {
    id: r.id,
    userId: r.user_id,
    title: r.title,
    mode: r.mode === 'data' ? 'data' : 'full',
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
const SESSION_COLS = `s.id, s.user_id, s.title, s.mode,
        s.adapter_kind, s.adapter_session_id, s.turn_count,
        s.created_at, s.updated_at,
        ((SELECT COUNT(*) FROM runs r WHERE r.chat_session_id = s.id)
         + (SELECT COUNT(*) FROM run_nodes n
            WHERE n.run_id IN (SELECT id FROM runs WHERE chat_session_id = s.id))
        ) AS msg_count`;

export class ChatHistoryStore {
  private readonly dbProvider: DatabaseProvider;
  private readonly userIdProvider: UserIdProvider;
  private readonly runs: AutomationRunsStore;
  // Both populated lazily on first method call — see `UserStore` for the
  // worker-subprocess rationale that justifies the lazy pattern across all
  // gateway-state stores.
  private db: DatabaseSync | undefined;
  private stmts: PreparedStatements | undefined;

  constructor(dbProvider: DatabaseProvider, userIdProvider: UserIdProvider) {
    this.dbProvider = dbProvider;
    this.userIdProvider = userIdProvider;
    this.runs = new AutomationRunsStore(dbProvider);
  }

  private ensureReady(): { db: DatabaseSync; stmts: PreparedStatements } {
    if (this.db && this.stmts) return { db: this.db, stmts: this.stmts };
    const db = this.dbProvider();
    const stmts: PreparedStatements = {
      list: db.prepare(
        `SELECT ${SESSION_COLS}
         FROM chat_sessions s
         WHERE s.user_id = ?
         ORDER BY s.updated_at DESC`,
      ),
      insertSession: db.prepare(
        `INSERT INTO chat_sessions
           (id, user_id, title, mode,
            adapter_kind, adapter_session_id, turn_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, NULL, 0, ?, ?)`,
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
    this.db = db;
    this.stmts = stmts;
    return { db, stmts };
  }

  /** Resolve the current user UUID for scoping reads + writes. */
  private currentUserId(): string {
    return this.userIdProvider();
  }

  /** List every session for the current user, most-recently-updated first. */
  listSessions(): ChatSessionMeta[] {
    const { stmts } = this.ensureReady();
    const rows = stmts.list.all(this.currentUserId()) as unknown as SessionRow[];
    return rows.map(mapSessionRow);
  }

  /**
   * Create a fresh chat session. `mode` is the sticky chat mode; `title`
   * is optionally pre-derived by the caller from the first user message.
   * The new row starts with turn_count 0 and NULL adapter columns.
   */
  createSession(mode: 'full' | 'data', title: string = ''): ChatSessionMeta {
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const now = Date.now();
    const id = randomUUID();
    stmts.insertSession.run(id, userId, title, mode, now, now);
    return {
      id,
      userId,
      title,
      mode,
      adapterKind: null,
      adapterSessionId: null,
      turnCount: 0,
      createdAt: now,
      updatedAt: now,
      messageCount: 0,
    };
  }

  /**
   * Load a session with its transcript reconstructed from the run ledger:
   * each `kind='chat'` run contributes a `user` message (the run's
   * `input_json`) followed by its `run_nodes` — `step` nodes as `ai`
   * messages, `tool` nodes as `tool` messages.
   */
  getSession(id: string): (ChatSessionMeta & { messages: ChatMessageRow[] }) | undefined {
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const row = stmts.getSession.get(id, userId) as unknown as SessionRow | undefined;
    if (!row) return undefined;

    const messages: ChatMessageRow[] = [];
    let idx = 0;
    for (const run of this.runs.listChatRuns(id)) {
      messages.push({
        idx: idx++,
        payload: { kind: 'user', text: parseUserMessage(run.inputJson) },
        createdAt: run.startedAt,
      });
      for (const node of this.runs.listNodes(run.runId)) {
        if (node.kind === 'step') {
          const parsed = parseStepOutput(node.outputJson);
          messages.push({
            idx: idx++,
            payload: { kind: 'ai', text: parsed.text, ...(parsed.error ? { error: true } : {}) },
            createdAt: node.startedAt,
          });
        } else if (node.kind === 'tool') {
          const args = parseToolArgs(node.argsJson);
          const out = parseToolOutput(node.outputJson);
          messages.push({
            idx: idx++,
            payload: {
              kind: 'tool',
              id: node.nodeId,
              tool: node.name ?? 'tool',
              ...(args.sql !== undefined ? { sql: args.sql } : {}),
              ...(args.args !== undefined ? { args: args.args } : {}),
              state: node.ok ? 'ok' : 'error',
              ...(out.result !== undefined ? { result: out.result } : {}),
              ...(out.errorText !== undefined ? { errorText: out.errorText } : {}),
            },
            createdAt: node.startedAt,
          });
        }
      }
    }
    const meta = mapSessionRow(row);
    return { ...meta, messageCount: messages.length, messages };
  }

  /** Session meta only (no transcript). Cheap — the `_chat` POST route
   *  uses this to read sticky mode + runner-resume handles per turn. */
  getSessionMeta(id: string): ChatSessionMeta | undefined {
    const { stmts } = this.ensureReady();
    const row = stmts.getSession.get(id, this.currentUserId()) as unknown as SessionRow | undefined;
    return row ? mapSessionRow(row) : undefined;
  }

  renameSession(id: string, title: string): ChatSessionMeta | undefined {
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const res = stmts.rename.run(title, Date.now(), id, userId);
    if (Number(res.changes) === 0) return undefined;
    return this.getSessionMeta(id);
  }

  deleteSession(id: string): boolean {
    const { stmts } = this.ensureReady();
    // `runs.chat_session_id` is an ON DELETE CASCADE FK, so the session's
    // turns (and their cascading `run_nodes`) drop with the session.
    const res = stmts.deleteSession.run(id, this.currentUserId());
    return Number(res.changes) > 0;
  }

  /**
   * Persist one completed chat turn as a `runs` row plus its `run_nodes`
   * trace. Returns `undefined` if the session doesn't exist or is owned by
   * a different user (cross-user writes are silently impossible). When the
   * session title is still empty it is derived from the user message — the
   * first turn names the conversation.
   */
  recordTurn(input: RecordTurnInput): { runId: string } | undefined {
    const { db, stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const existing = stmts.titleOf.get(input.chatSessionId, userId) as
      | { title: string }
      | undefined;
    if (!existing) return undefined;

    const runId = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      this.runs.insertRun({
        runId,
        kind: 'chat',
        triggerKind: 'interactive',
        chatSessionId: input.chatSessionId,
        inputJson: JSON.stringify({ message: input.userMessage }),
        startedAt: input.startedAt,
      });
      input.nodes.forEach((node, ordinal) => {
        if (node.kind === 'step') {
          // Freeze the per-call cost at write time from the model price
          // table — NULL when the model is unknown (distinct from $0).
          const cost = costForUsage(node.model, {
            ...(node.inputTokens !== undefined ? { inputTokens: node.inputTokens } : {}),
            ...(node.outputTokens !== undefined ? { outputTokens: node.outputTokens } : {}),
            ...(node.cacheReadTokens !== undefined
              ? { cacheReadTokens: node.cacheReadTokens }
              : {}),
            ...(node.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: node.cacheWriteTokens }
              : {}),
          });
          this.runs.insertNode({
            nodeId: randomUUID(),
            runId,
            ordinal,
            kind: 'step',
            outputJson: JSON.stringify({
              text: node.text,
              ...(node.isError ? { error: true } : {}),
            }),
            ok: !node.isError,
            ...(node.model !== undefined ? { model: node.model } : {}),
            ...(node.provider !== undefined ? { provider: node.provider } : {}),
            ...(node.inputTokens !== undefined ? { inputTokens: node.inputTokens } : {}),
            ...(node.outputTokens !== undefined ? { outputTokens: node.outputTokens } : {}),
            ...(node.cacheReadTokens !== undefined
              ? { cacheReadTokens: node.cacheReadTokens }
              : {}),
            ...(node.cacheWriteTokens !== undefined
              ? { cacheWriteTokens: node.cacheWriteTokens }
              : {}),
            ...(cost !== undefined ? { costUsd: cost } : {}),
            startedAt: node.startedAt,
            endedAt: node.endedAt,
            durationMs: Math.max(0, node.endedAt - node.startedAt),
          });
        } else {
          this.runs.insertNode({
            nodeId: randomUUID(),
            runId,
            ordinal,
            kind: 'tool',
            name: node.toolName,
            argsJson: JSON.stringify({
              ...(node.sql !== undefined ? { sql: node.sql } : {}),
              ...(node.args !== undefined ? { args: node.args } : {}),
            }),
            outputJson: JSON.stringify({
              ...(node.result !== undefined ? { result: node.result } : {}),
              ...(node.errorText !== undefined ? { errorText: node.errorText } : {}),
            }),
            ok: node.ok,
            ...(node.errorText !== undefined ? { error: node.errorText } : {}),
            ...(node.appId !== undefined ? { appId: node.appId } : {}),
            startedAt: node.startedAt,
            endedAt: node.endedAt,
            durationMs: Math.max(0, node.endedAt - node.startedAt),
          });
        }
      });
      this.runs.finishRun({
        runId,
        endedAt: input.endedAt,
        ok: input.ok,
        ...(input.error !== undefined ? { error: input.error } : {}),
        ...(input.finalText !== undefined
          ? { outputJson: JSON.stringify({ text: input.finalText }) }
          : {}),
      });
      const now = Date.now();
      if (!existing.title) {
        stmts.setTitle.run(deriveTitle(input.userMessage), now, input.chatSessionId, userId);
      } else {
        stmts.touch.run(now, input.chatSessionId, userId);
      }
      db.exec('COMMIT');
      return { runId };
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Record turn completion: bump `turn_count` + `updated_at`, and persist
   * the runner-resume handle. When `adapter` is provided, `adapter_kind` is
   * always set; `adapter_session_id` is only overwritten when
   * `adapter.sessionId` is defined. When `adapter` is omitted, only the
   * counters move. Returns the updated meta, or `undefined` if the session
   * is missing / owned by another user.
   */
  noteTurn(
    sessionId: string,
    adapter?: { kind: string; sessionId?: string },
  ): ChatSessionMeta | undefined {
    const { stmts } = this.ensureReady();
    const userId = this.currentUserId();
    const now = Date.now();
    let res;
    if (adapter && adapter.sessionId !== undefined) {
      res = stmts.noteTurnWithAdapter.run(now, adapter.kind, adapter.sessionId, sessionId, userId);
    } else if (adapter) {
      res = stmts.noteTurnKindOnly.run(now, adapter.kind, sessionId, userId);
    } else {
      res = stmts.noteTurnNoAdapter.run(now, sessionId, userId);
    }
    if (Number(res.changes) === 0) return undefined;
    return this.getSessionMeta(sessionId);
  }
}

export function deriveTitle(text: string): string {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '';
  if (cleaned.length <= 60) return cleaned;
  return `${cleaned.slice(0, 57)}…`;
}

// HTTP route dispatcher lives in chat-history-routes.ts to keep this file
// focused on schema + store. Re-exported below from the package index.
