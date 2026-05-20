/**
 * Shared types for the centraid openclaw plugin.
 *
 * The OpenClaw plugin SDK types are not yet pinned in this package — see
 * `lib/sdk-shim.ts` for the minimal subset we depend on. When the SDK is
 * installed locally we'll switch to the real imports.
 */

export type AppId = string;

/** A registered app's metadata persisted in <appsDir>/_registry.json. */
export type AppMode = 'uploaded' | 'path';

export interface RegistryEntry {
  id: AppId;
  /**
   * Absolute path to the app's *root* folder.
   *
   * - In `uploaded` mode this is `<appsDir>/<id>/` — a wrapper containing
   *   `data.sqlite`, `current.json`, and `versions/<v_...>/`. Code is
   *   resolved through `current.json#activeVersion`.
   * - In `path` mode this is whatever external folder the user registered
   *   directly. Code, data, and handlers all live there with no versioning.
   */
  path: string;
  mode: AppMode;
  registeredAt: string;
}

/** Shape exported by `queries/<id>.js`. Default export only. */
export interface QueryModule {
  default: HandlerFn<QueryHandlerArgs, unknown>;
}

/** Shape exported by `actions/<id>.js`. Default export only. */
export interface ActionModule {
  default: HandlerFn<ActionHandlerArgs, ActionResult>;
}

export type HandlerFn<Args, Ret = void> = (args: Args) => Promise<Ret>;

/**
 * Public handler type aliases — apps written in TypeScript can use these
 * to type their handler default exports:
 *
 * ```ts
 * import type { QueryHandler } from "@centraid/openclaw-plugin";
 * export default (async ({ db, query }) => {
 *   return await db
 *     .prepare("SELECT * FROM issues WHERE state = ?")
 *     .all(query.state ?? "open");
 * }) satisfies QueryHandler;
 * ```
 *
 * The `ScopedDb` API is fully async — every `exec` / `run` / `get` / `all`
 * call round-trips through the worker boundary to the parent process. Always
 * `await` your db calls.
 */
export type QueryHandler = HandlerFn<QueryHandlerArgs, unknown>;
export type ActionHandler = HandlerFn<ActionHandlerArgs, ActionResult>;

export interface ScopedDb {
  exec(sql: string): Promise<void>;
  prepare(sql: string): {
    run(...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
    get<T = unknown>(...params: unknown[]): Promise<T | undefined>;
    all<T = unknown>(...params: unknown[]): Promise<T[]>;
  };
  transaction<Fn extends (...args: unknown[]) => Promise<unknown>>(fn: Fn): Fn;
}

export interface ScopedLog {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export type ScopedFetch = (input: string, init?: RequestInit) => Promise<Response>;

export interface AppRef {
  readonly id: AppId;
  readonly dir: string;
}

export interface CommonHandlerArgs {
  db: ScopedDb;
  log: ScopedLog;
  app: AppRef;
  ctx: {
    fetch: ScopedFetch;
    abortSignal: AbortSignal;
  };
}

export interface QueryHandlerArgs extends CommonHandlerArgs {
  /** Query-string params from the URL. */
  query: Record<string, string>;
  /** Path params (currently empty — reserved for future shape changes). */
  params: Record<string, string>;
}

export interface ActionHandlerArgs extends CommonHandlerArgs {
  body: unknown;
  params: Record<string, string>;
}

export interface ActionResult {
  status?: number;
  body?: unknown;
}

/**
 * JSON-schema-ish shape passed to `ctx.agent({ json: ... })`. We don't
 * narrow further here — the runner forwards it to the host's structured
 * output enforcement and rejects on parse failure.
 */
export type AutomationJsonSchema = Record<string, unknown>;

export interface AutomationAgentArgs {
  /** The user-or-handler-supplied prompt to the model. */
  prompt: string;
  /**
   * Optional JSON schema enforced on the response. When provided, the
   * runner re-prompts (or fails) until the model returns a value that
   * parses + validates; the resolved Promise carries the parsed object.
   *
   * Without `json`, the resolved value is the raw assistant text.
   *
   * Setting `json` is the recommended runtime failure detector — if the
   * host can't reach the required MCP / model, the schema check throws
   * loudly instead of writing garbage to the DB.
   */
  json?: AutomationJsonSchema;
}

/**
 * Cross-process state surface for handlers (issue #80). Backed by the
 * per-app `automations.sqlite` `state` table. Scope is per-automation:
 * `state.PK = (automation_name, key)`. Cross-automation state should go
 * through the app's own `data.sqlite` instead.
 */
export interface AutomationStateCtx {
  /** Resolve a previously-set value for this automation. Returns undefined when unset. */
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** Persist a JSON-serializable value for this automation. */
  set(key: string, value: unknown): Promise<void>;
  /** Drop the entry. */
  delete(key: string): Promise<void>;
}

/**
 * Lightweight handle on a past run. Mirrors `AutomationRunRow` but
 * pre-parses `inputJson`/`outputJson` for handler convenience.
 */
export interface AutomationRunRef {
  runId: string;
  automationName: string;
  triggerKind: 'scheduled' | 'manual' | 'replay' | 'on_failure';
  startedAt: number;
  endedAt?: number;
  ok: boolean;
  error?: string;
  summary?: string;
  input?: unknown;
  output?: unknown;
}

export interface AutomationRunsListFilter {
  /** Defaults to the currently-executing automation. */
  name?: string;
  /** Only return runs whose `ok` flag matches. */
  status?: 'ok' | 'error';
  /** `started_at` lower bound (inclusive, ms epoch). */
  since?: number;
  /** Max rows. Defaults to 50. */
  limit?: number;
}

export interface AutomationRunsCtx {
  /**
   * Most-recent run record. With no filter, returns the most recent
   * for the currently-executing automation; pass `{status: 'ok'}` for
   * the "since last successful run" cursor pattern.
   */
  last(filter?: { name?: string; status?: 'ok' | 'error' }): Promise<AutomationRunRef | undefined>;
  /** List run records newest-first. */
  list(filter?: AutomationRunsListFilter): Promise<AutomationRunRef[]>;
}

export interface AutomationInvokeArgs {
  /** Optional payload passed to the child run; lands in `runs.input_json`. */
  input?: unknown;
}

export interface AutomationCtx {
  /**
   * Invoke one host tool (MCP or builtin) deterministically. Result type
   * is intentionally `unknown` — the handler narrows with a JSDoc cast.
   * Concurrent calls (via Promise.all) are batched into one host agent
   * turn for cold-start amortization. A failed tool call rejects the
   * returned Promise — retry / backoff / error-classification is the
   * handler's job (it's plain JS; use `try/catch`).
   */
  tool(name: string, args: unknown): Promise<unknown>;
  /**
   * Constrained one-shot inference against the user's real provider.
   * Returns the parsed JSON object when `json:` schema is set, otherwise
   * the raw assistant text.
   */
  agent(args: AutomationAgentArgs): Promise<unknown>;
  /**
   * Cross-fire state surface (issue #80). Backed by the per-app
   * `automations.sqlite`. Persists across desktop restarts.
   */
  state: AutomationStateCtx;
  /**
   * Run audit query surface (issue #80). Read-only view of the per-app
   * `runs` table. Used by handlers for the "since last successful run"
   * cursor pattern and aggregating / catch-up automations.
   */
  runs: AutomationRunsCtx;
  /**
   * Synchronously invoke another automation in the same app and return
   * its `output` (issue #80). Links the child run to this one via
   * `parent_run_id`. Intra-app only.
   */
  invoke(name: string, args?: AutomationInvokeArgs): Promise<unknown>;
  /**
   * AbortSignal that fires when the run is being torn down (timeout,
   * SIGTERM from the OS scheduler, manual cancel).
   */
  abortSignal: AbortSignal;
}

export interface AutomationHandlerArgs {
  db: ScopedDb;
  log: ScopedLog;
  app: AppRef;
  ctx: AutomationCtx;
}

/**
 * Shape of an automation `.js` handler's default export. Automations
 * receive a different `ctx` from queries/actions (no `fetch`; adds
 * `tool` + `agent`) because their execution model is different: a cron
 * fire has no human session, no HTTP request, no inbound body.
 */
export type AutomationHandler = HandlerFn<AutomationHandlerArgs, unknown>;

export interface AutomationModule {
  default: AutomationHandler;
}
