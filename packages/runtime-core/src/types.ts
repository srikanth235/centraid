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
  /** Per-cron webhook tokens, keyed by cron id. */
  cronTokens: Record<string, string>;
  /** Mirrored cron status, keyed by cron id. */
  cronStatus: Record<string, CronStatus>;
}

export interface CronStatus {
  lastRunAtMs?: number;
  lastRunStatus?: 'success' | 'failure' | 'running' | 'scheduled';
  lastError?: string;
  nextRunAtMs?: number;
}

/** Shape exported by `crons/<id>.js` per app. */
export interface CronModule {
  schedule:
    | { cron: string; tz?: string; exact?: boolean }
    | { every: string }
    | { at: string; tz?: string };
  execution?: 'main' | 'isolated' | 'current' | { session: string };
  task: {
    prompt: string;
    toolAllow?: string[];
    model?: string;
  };
  timeoutMs?: number;
  default: HandlerFn<CronHandlerArgs>;
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
export type CronHandler = HandlerFn<CronHandlerArgs, void>;

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

export interface CronHandlerArgs extends CommonHandlerArgs {
  payload: {
    text: string;
    json?: unknown;
    raw: string;
    headers: Record<string, string>;
    jobId: string;
    runId?: string;
  };
}
