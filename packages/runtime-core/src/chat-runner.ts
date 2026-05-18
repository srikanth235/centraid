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
 *     app-server / Claude SDK locally, with the agent shelling out to
 *     the bundled `centraid` CLI for SQL access.
 *
 * Either way, the route handler in runtime-core never implements a model
 * loop itself; it just translates the runner's `ChatStreamEvent`s into SSE
 * frames and pipes them back to the harness client.
 */

export type ChatMode = 'full' | 'data';

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
  | { type: 'aborted' };

export interface ChatRunInput {
  appId: string;
  /**
   * Absolute path to the app's data directory — `entry.path` as resolved by
   * `appDataDir(entry)`. For uploaded apps this is `<appsDir>/<id>`; for
   * path-registered apps it's the externally-supplied folder. `data.sqlite`,
   * the `_chat/` transcripts, and the live schema all live here. Adapters
   * that spawn a subprocess agent (codex / claude-code) MUST use this as the
   * spawn cwd so the workspace sandbox covers the file the agent reads/writes.
   */
  dataDir: string;
  /** Renderer-supplied window id; pinned to one transcript per (appId, windowId). */
  windowId: string;
  /**
   * Absolute path to the on-disk transcript file for this window —
   * `<dataDir>/_chat/w<windowId>.jsonl`. The runner is free to use this for
   * its own session-resume mechanism (pi session file, codex thread id
   * stored alongside, …).
   */
  sessionFile: string;
  mode: ChatMode;
  message: string;
  /**
   * App-context prompt the runtime-core builds (app name, description,
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
  onEvent: (event: ChatStreamEvent) => void;
}

export interface ChatRunResult {
  /**
   * Resumable session id assigned by the adapter (codex thread id,
   * claude-code session id). Omitted by adapters whose resume happens via
   * the on-disk `sessionFile` (OpenClaw runner). The route handler
   * persists this to `_chat/index.json` so the next turn can resume.
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
