/**
 * Shared types for the centraid openclaw plugin.
 *
 * The OpenClaw plugin SDK types are not yet pinned in this package — see
 * `lib/sdk-shim.ts` for the minimal subset we depend on. When the SDK is
 * installed locally we'll switch to the real imports.
 */

export type AppId = string;

/**
 * A registered app's metadata persisted in `<appsDir>/_registry.json`.
 *
 * Every registered app is "uploaded" mode: a wrapper folder under
 * `<appsDir>/<id>/` holding runtime state (logs.jsonl, settings.json,
 * attachment blobs). Code lives in the git store and is resolved through
 * the code-dir override; app data lives in the vault (issue #286).
 */
export interface RegistryEntry {
  id: AppId;
  /** Absolute path to the app's root folder: `<appsDir>/<id>/`. */
  path: string;
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
 * export default (async ({ query, ctx }) => {
 *   const out = await ctx.vault.read({
 *     entity: 'schedule.task',
 *     purpose: 'dpv:ServiceProvision',
 *   });
 *   return out;
 * }) satisfies QueryHandler;
 * ```
 *
 * The `ScopedVault` API is fully async — every call round-trips through
 * the worker boundary to the parent process, which holds the app's vault
 * credential and enforces consent. Always `await` your vault calls.
 */
export type QueryHandler = HandlerFn<QueryHandlerArgs, unknown>;
export type ActionHandler = HandlerFn<ActionHandlerArgs, ActionResult>;

/** The handler-side `ctx.vault` surface (see worker/runner.ts). */
export interface ScopedVault {
  read(request: Record<string, unknown>): Promise<unknown>;
  search(request: Record<string, unknown>): Promise<unknown>;
  invoke(request: Record<string, unknown>): Promise<unknown>;
  query(view: string, purpose: string): Promise<unknown>;
  describe(): Promise<unknown>;
  parked(): Promise<unknown>;
  resolve(request: Record<string, unknown>): Promise<unknown>;
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
  log: ScopedLog;
  app: AppRef;
  ctx: {
    fetch: ScopedFetch;
    abortSignal: AbortSignal;
    vault: ScopedVault;
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
