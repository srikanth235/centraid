/*
 * Host-agnostic chat-runner interface.
 *
 * The per-app chat endpoint (`POST /centraid/<appId>/_turn`) delegates the
 * actual model turn to a host-injected `ConversationRunner`. Two implementations
 * exist today:
 *
 *   - `@centraid/agent-runtime`'s `makeConversationRunner` — drives codex
 *     app-server / Claude SDK locally; hosts thread the vault-register
 *     tools (`vault_sql` / `vault_invoke`) in per turn.
 *   - the gateway's `makeUnifiedConversationRunner` — the same core, plus
 *     draft-worktree file tools for builder chat.
 *
 * Either way, the route handler in app-engine never implements a model
 * loop itself; it just translates the runner's `TurnStreamEvent`s into SSE
 * frames and pipes them back to the harness client.
 */

import type { RunKind } from './schema.js';
import type { TurnAttachment } from './turn.js';

/**
 * Normalized stream events both adapters emit. The route handler translates
 * each event into one SSE frame; the harness consumes the SSE stream.
 *
 * Discriminated on `type`. Adapters are free to emit a subset — the
 * harness handles unknown event types gracefully and ignores them.
 */
export type TurnStreamEvent =
  | { type: 'assistant.start' }
  | { type: 'assistant.delta'; delta: string }
  | { type: 'reasoning.delta'; delta: string }
  | {
      type: 'tool.start';
      toolCallId: string;
      toolName: string;
      args?: unknown;
      /** When the tool is a centraid_sql_* tool, the SQL is surfaced separately for the UI. */
      sql?: string;
      /** ACP tool kind when the agent supplied one (read/edit/delete/move/…​). */
      kind?: string;
    }
  | {
      type: 'tool.result';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result?: unknown;
      /** Plain-text error message when `ok === false`. */
      errorText?: string;
      /**
       * Structured file diffs extracted from ACP tool content blocks
       * (`type: "diff"`), when the agent reported them.
       */
      diffs?: Array<{ path?: string; oldText?: string; newText?: string }>;
    }
  | {
      type: 'phase';
      phase: string;
      detail?: unknown;
      /** Normalized plan entries when `phase === 'plan'`. */
      plan?: Array<{ content: string; status?: string; priority?: string }>;
    }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'aborted' }
  /**
   * A non-fatal, human-readable notice about the turn — surfaced in the
   * transcript, never folded into the ledger (issue #420). Today's sole use:
   * a runner that can't consume an attachment kind (e.g. Codex silently drops
   * PDF `document` blocks) emits `code:'attachment_unsupported'` so the user
   * sees "this runner can't read PDF attachments" instead of nothing. Both
   * chat surfaces render it via the shared parser.
   */
  | { type: 'notice'; level: 'warn' | 'info'; code?: string; message: string }
  /**
   * Webhook secrets minted as a post-turn step (issue #141, Phase 3). When
   * a unified-chat turn authors an automation with a pending webhook
   * trigger, the gateway mints the route id + shared secret after the turn
   * settles (the agent can't generate crypto-random credentials) and
   * surfaces them here exactly once — the plaintext `secret` is never
   * persisted, so the renderer must capture it from this event. Adapters
   * that don't author code (data-only chat) never emit it.
   */
  | {
      type: 'webhooks';
      minted: Array<{
        automationId: string;
        ownerApp: string;
        webhookId: string;
        url: string;
        secret: string;
      }>;
    }
  /**
   * Per-turn token usage, emitted once when the runner reports the
   * turn's totals (codex `turn/completed`, Claude SDK `result`). The
   * chat route folds this into the turn's `kind='step'` run node so the
   * unified ledger has real token + cost accounting for chat turns.
   * Adapters that can't surface usage simply never emit it.
   */
  | {
      type: 'usage';
      model?: string;
      provider?: string;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheWriteTokens?: number;
      /**
       * USD cost: agent/ACP-reported when present; otherwise filled at the SSE
       * seam from the catalog (issue #514). See `costSource`.
       */
      costUsd?: number;
      /** Where `costUsd` came from — agent report vs catalog estimate. */
      costSource?: 'agent' | 'estimated';
    };

export interface ConversationTurnInput {
  appId: string;
  /**
   * Optional draft-worktree session to use for this turn. Builder hosts use
   * this to isolate one-shot authoring work (such as an automation compile)
   * from the app's persistent interactive editing session.
   */
  draftSessionId?: string;
  /**
   * Absolute path to the app's data directory — `entry.path` as resolved by
   * `appDataDir(entry)`. For uploaded apps this is `<appsDir>/<id>`; for
   * path-registered apps it's the externally-supplied folder. `data.sqlite`
   * and the live schema live here. Adapters that spawn a subprocess agent
   * (codex / claude-code) MUST use this as the spawn cwd so the workspace
   * sandbox covers the file the agent reads/writes.
   */
  dataDir: string;
  /**
   * The chat session id — the `conversations` row id in the per-app runtime
   * SQLite the transcript persists to.
   */
  conversationId: string;
  /**
   * Absolute path to a runner-owned scratch session file (under the central
   * `conversationRunnerSessionDir`, named `<conversationId>.jsonl`). The runner is free to
   * use this for its own file-based session-resume mechanism, if it has one.
   * It is NOT the chat transcript — the transcript lives in the gateway DB.
   */
  sessionFile: string;
  message: string;
  /**
   * Which chat register the turn belongs to (issue #286 phase 2). `'ask'`
   * marks the user-facing app copilot ("operate/ask about my data") —
   * hosts may route vault-backed apps' ask turns onto the vault register
   * (vault_sql/vault_invoke with an app lens). Absent/`'build'` keeps the
   * builder-capable unified runner. Threaded from the `_turn` POST body.
   */
  register?: 'ask' | 'build';
  /**
   * Files attached to this turn's inbound message — already landed in the
   * per-app blob CAS; `path` is the absolute blob path (issue #190). The
   * route resolves these from the turn POST body's attachment refs; the
   * runner threads them into the adapter as multimodal content blocks.
   */
  attachments?: TurnAttachment[];
  /**
   * App-context prompt the app-engine builds (app name, description,
   * live schema). Adapters splice this into their own system-prompt flag.
   */
  extraSystemPrompt: string;
  model?: string;
  thinking?: string;
  abortSignal: AbortSignal;
  /**
   * Idempotency key supplied by the harness — same turn re-tried with the
   * same key should not be re-driven if the adapter supports it. Plumbed
   * through but not load-bearing (the route's `abortSignal` plus the
   * per-window queue is the primary correctness guarantee).
   */
  idempotencyKey?: string;
  /**
   * The runner's previous resume handle, read from the `conversations` row
   * by the route. The adapter resumes only when `prevAdapterKind` matches
   * the kind it's about to use — a mid-session runner switch starts fresh.
   */
  prevAdapterSessionId?: string;
  prevAdapterKind?: string;
  onEvent: (event: TurnStreamEvent) => void;
}

export interface ConversationTurnResult {
  /**
   * Resumable session id assigned by the adapter (codex thread id,
   * claude-code session id). Omitted by adapters whose resume happens via
   * the on-disk `sessionFile` instead. The route handler persists this to
   * the session's `conversations` row so the next turn can resume.
   */
  adapterSessionId?: string;
  /** Adapter kind that wrote `adapterSessionId`. */
  adapterKind?: string;
}

export interface ConversationRunner {
  /**
   * The ledger `RunKind` a turn through this runner persists as — a property
   * of the *surface*, not the individual turn. The builder-capable unified
   * runner (draft worktree + file-edit tools + authoring prompt) reports
   * `'build'`; the data-only runner leaves it unset (the route defaults to
   * `'chat'`). Read statically by the route, so the kind is recorded even
   * when a turn errors and returns no `ConversationTurnResult` (issue #181).
   */
  readonly runKind?: RunKind;
  /** Drive one turn. Resolves when the model has emitted its final reply
   *  or the run aborted/errored. Errors are reported via `onEvent`
   *  (type: 'error') AND by rejecting the returned promise — the route
   *  handler relies on the rejection to release the per-session lock. */
  run(input: ConversationTurnInput): Promise<ConversationTurnResult | void>;
}
