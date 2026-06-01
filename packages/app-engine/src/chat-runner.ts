/*
 * Host-agnostic chat-runner interface.
 *
 * The per-app chat endpoint (`POST /centraid/<appId>/_chat`) delegates the
 * actual model turn to a host-injected `ChatRunner`. Two implementations
 * exist today:
 *
 *   - `openclaw-plugin/lib/openclaw-chat-runner.ts` — wraps
 *     `api.runtime.agent.runEmbeddedAgent`. OpenClaw owns the loop and
 *     dispatches plugin-registered tools server-side.
 *   - `@centraid/agent-runtime`'s `makeChatRunner` — drives codex
 *     app-server / Claude SDK locally with the three structured tools
 *     declared inline (`centraid_describe` / `centraid_read` / `centraid_write`).
 *
 * Either way, the route handler in app-engine never implements a model
 * loop itself; it just translates the runner's `ChatStreamEvent`s into SSE
 * frames and pipes them back to the harness client.
 */

/**
 * Normalized stream events both adapters emit. The route handler translates
 * each event into one SSE frame; the harness consumes the SSE stream.
 *
 * Discriminated on `type`. Adapters are free to emit a subset — the
 * harness handles unknown event types gracefully and ignores them.
 */
export type ChatStreamEvent =
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
    }
  | {
      type: 'tool.result';
      toolCallId: string;
      toolName: string;
      ok: boolean;
      result?: unknown;
      /** Plain-text error message when `ok === false`. */
      errorText?: string;
    }
  | { type: 'phase'; phase: string; detail?: unknown }
  | { type: 'final'; text: string }
  | { type: 'error'; message: string }
  | { type: 'aborted' }
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
    };

export interface ChatRunInput {
  appId: string;
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
   * The chat session id. A chat session IS the chat window, so this is the
   * window id — it's also the `chat_sessions` row id in the central gateway
   * SQLite the transcript persists to.
   */
  windowId: string;
  /**
   * Absolute path to a runner-owned scratch session file (under the central
   * `chatRunnerSessionDir`, named `<windowId>.jsonl`). The runner is free to
   * use this for its own session-resume mechanism (e.g. the OpenClaw runner
   * hands it to `runEmbeddedAgent` as its session-resume file). It is NOT the
   * chat transcript — the transcript lives in the gateway DB.
   */
  sessionFile: string;
  message: string;
  /**
   * App-context prompt the app-engine builds (app name, description,
   * live schema). Adapters splice this into their own `extraSystemPrompt`
   * (OpenClaw) or system-prompt flag (CLI adapters).
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
   * The runner's previous resume handle, read from the `chat_sessions` row
   * by the route. The adapter resumes only when `prevAdapterKind` matches
   * the kind it's about to use — a mid-session runner switch starts fresh.
   */
  prevAdapterSessionId?: string;
  prevAdapterKind?: string;
  onEvent: (event: ChatStreamEvent) => void;
}

export interface ChatRunResult {
  /**
   * Resumable session id assigned by the adapter (codex thread id,
   * claude-code session id). Omitted by adapters whose resume happens via
   * the on-disk `sessionFile` (OpenClaw runner). The route handler persists
   * this to the session's `chat_sessions` row so the next turn can resume.
   */
  adapterSessionId?: string;
  /** Adapter kind that wrote `adapterSessionId`. */
  adapterKind?: string;
}

export interface ChatRunner {
  /** Drive one turn. Resolves when the model has emitted its final reply
   *  or the run aborted/errored. Errors are reported via `onEvent`
   *  (type: 'error') AND by rejecting the returned promise — the route
   *  handler relies on the rejection to release the per-session lock. */
  run(input: ChatRunInput): Promise<ChatRunResult | void>;
}
