/*
 * Centraid chat store — the conversation-container store + transcript fold.
 *
 * Chat is app-scoped (issue #98): `chat_sessions` and a chat turn's run
 * ledger live in the owning app's per-app `runtime.sqlite` — the same
 * file as the app's automation runs. One `ChatHistoryStore` fronts every
 * app; each method takes the `appId` and resolves
 * `<appsDir>/<appId>/runtime.sqlite` lazily, caching the connection +
 * prepared statements per app. Sessions are still scoped by the
 * gateway-side user UUID (`UserStore.getUserId`) so a multi-user gateway
 * stays correct.
 *
 * The transcript is NOT its own table. A chat turn is a `runs` row
 * (`kind='chat'`, `chat_session_id` FK) and the turn's messages are
 * `run_nodes` (issue #90 fold: `chat_messages` is gone). `recordTurn`
 * writes that trace; `getSession` reconstructs the renderer transcript.
 * Exposed over HTTP at `/_centraid-chat`, mounted identically by the
 * OpenClaw plugin and the embedded local runtime.
 */

import path from 'node:path';
import { type DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { makeRuntimeDbProvider, type DatabaseProvider } from './gateway-db.js';
import { AgentRunsStore } from './agent-runs-store.js';
import type { RunSummarySink } from './run-summary-sink.js';
import { isValidAppId } from './app-paths.js';
import { costForUsage } from './model-pricing.js';
import { mapSessionRow, prepareChatStatements, type ChatStatements } from './chat-history-sql.js';
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

/** Per-app lazily-opened chat state — one entry per app touched. */
interface AppChat {
  db: DatabaseSync;
  stmts: ChatStatements;
  runs: AgentRunsStore;
}

export class ChatHistoryStore {
  private readonly appsDir: string;
  private readonly userIdProvider: UserIdProvider;
  private readonly analytics: RunSummarySink | undefined;
  // One entry per app whose chat has been touched this process. Each is
  // opened lazily — see `UserStore` for the worker-subprocess rationale
  // behind the lazy pattern across gateway-state stores.
  private readonly perApp = new Map<string, AppChat>();

  /** `analytics`, when set, threads into each app's runs store so a chat
   *  turn's `finishRun` write-throughs a summary (issue #98). */
  constructor(appsDir: string, userIdProvider: UserIdProvider, analytics?: RunSummarySink) {
    this.appsDir = appsDir;
    this.userIdProvider = userIdProvider;
    this.analytics = analytics;
  }

  /**
   * Resolve (and cache) one app's chat state. The DB file is the app's
   * `runtime.sqlite` — shared with its automation run ledger. `appId` is
   * validated because it indexes into the apps directory.
   */
  private appChat(appId: string): AppChat {
    const cached = this.perApp.get(appId);
    if (cached) return cached;
    if (!isValidAppId(appId)) throw new Error(`chat-history: invalid app id "${appId}"`);
    const provider: DatabaseProvider = makeRuntimeDbProvider(
      path.join(this.appsDir, appId, 'runtime.sqlite'),
    );
    const db = provider();
    const entry: AppChat = {
      db,
      stmts: prepareChatStatements(db),
      runs: new AgentRunsStore(provider, this.analytics),
    };
    this.perApp.set(appId, entry);
    return entry;
  }

  /** Resolve the current user UUID for scoping reads + writes. */
  private currentUserId(): string {
    return this.userIdProvider();
  }

  /** List every session for the current user in `appId`, newest-updated first. */
  listSessions(appId: string): ChatSessionMeta[] {
    const { stmts } = this.appChat(appId);
    const rows = stmts.list.all(this.currentUserId()) as unknown[];
    return (rows as Parameters<typeof mapSessionRow>[0][]).map(mapSessionRow);
  }

  /**
   * Create a fresh chat session in `appId`. `title` is optionally
   * pre-derived by the caller from the first user message. The new row
   * starts with turn_count 0 and NULL adapters.
   */
  createSession(appId: string, title: string = ''): ChatSessionMeta {
    const { stmts } = this.appChat(appId);
    const userId = this.currentUserId();
    const now = Date.now();
    const id = randomUUID();
    stmts.insertSession.run(id, userId, title, now, now);
    return {
      id,
      userId,
      title,
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
  getSession(
    appId: string,
    id: string,
  ): (ChatSessionMeta & { messages: ChatMessageRow[] }) | undefined {
    const { stmts, runs } = this.appChat(appId);
    const userId = this.currentUserId();
    const row = stmts.getSession.get(id, userId) as unknown;
    if (!row) return undefined;

    const messages: ChatMessageRow[] = [];
    let idx = 0;
    for (const run of runs.listChatRuns(id)) {
      messages.push({
        idx: idx++,
        payload: { kind: 'user', text: parseUserMessage(run.inputJson) },
        createdAt: run.startedAt,
      });
      for (const node of runs.listNodes(run.runId)) {
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
    const meta = mapSessionRow(row as Parameters<typeof mapSessionRow>[0]);
    return { ...meta, messageCount: messages.length, messages };
  }

  /** Session meta only (no transcript). Cheap — the `_chat` POST route
   *  uses this to read the runner-resume handle per turn. */
  getSessionMeta(appId: string, id: string): ChatSessionMeta | undefined {
    const { stmts } = this.appChat(appId);
    const row = stmts.getSession.get(id, this.currentUserId()) as unknown;
    return row ? mapSessionRow(row as Parameters<typeof mapSessionRow>[0]) : undefined;
  }

  renameSession(appId: string, id: string, title: string): ChatSessionMeta | undefined {
    const { stmts } = this.appChat(appId);
    const userId = this.currentUserId();
    const res = stmts.rename.run(title, Date.now(), id, userId);
    if (Number(res.changes) === 0) return undefined;
    return this.getSessionMeta(appId, id);
  }

  deleteSession(appId: string, id: string): boolean {
    const { stmts } = this.appChat(appId);
    // `runs.chat_session_id` is an ON DELETE CASCADE FK within the app's
    // own `runtime.sqlite`, so the session's turns (and their cascading
    // `run_nodes`) drop with the session.
    const res = stmts.deleteSession.run(id, this.currentUserId());
    return Number(res.changes) > 0;
  }

  /**
   * Persist one completed chat turn as a `runs` row plus its `run_nodes`
   * trace, in `appId`'s `runtime.sqlite`. Returns `undefined` if the
   * session doesn't exist or is owned by a different user (cross-user
   * writes are silently impossible). When the session title is still
   * empty it is derived from the user message — the first turn names the
   * conversation.
   */
  recordTurn(appId: string, input: RecordTurnInput): { runId: string } | undefined {
    const { db, stmts, runs } = this.appChat(appId);
    const userId = this.currentUserId();
    const existing = stmts.titleOf.get(input.chatSessionId, userId) as
      | { title: string }
      | undefined;
    if (!existing) return undefined;

    const runId = randomUUID();
    db.exec('BEGIN IMMEDIATE');
    try {
      runs.insertRun({
        runId,
        kind: 'chat',
        triggerKind: 'interactive',
        chatSessionId: input.chatSessionId,
        appId,
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
          runs.insertNode({
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
          runs.insertNode({
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
      runs.finishRun({
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
    appId: string,
    sessionId: string,
    adapter?: { kind: string; sessionId?: string },
  ): ChatSessionMeta | undefined {
    const { stmts } = this.appChat(appId);
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
    return this.getSessionMeta(appId, sessionId);
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
