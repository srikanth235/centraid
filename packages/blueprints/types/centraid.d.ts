// Global ambient types for the blueprint apps (TS + CSS-modules conversion).
//
// These are GLOBALS on purpose: handlers and page code reference `HandlerArgs`,
// `HandlerCtx`, `VaultOutcome`, and `window.centraid` by bare name so no value
// import crosses the app/kit boundary at runtime (esbuild would 404 a plain
// import of a types-only module; `import type` is stripped, but a global spares
// the ceremony entirely). Grounded in the real surfaces:
//   - `window.centraid` — the injected change-bridge client
//     (packages/app-engine/src/http/bridge-script.ts) and its faithful mock
//     (packages/blueprints/visual-harness/mock-centraid.js): read/write/onChange.
//   - `ctx.vault` — the handler-side vault RPC surface
//     (packages/app-engine/src/worker/runner.ts `ScopedVault`,
//     packages/app-engine/src/types.ts `CommonHandlerArgs`/`ActionResult`).
//   - `VaultOutcome` — the typed-command result the kit narrates
//     (packages/blueprints/kit/kit.js `outcomeMessage`).
//
// This file is a module (see the trailing `export {}`) so `declare global`
// applies; every type inside `declare global` is visible unqualified.

declare global {
  // ---------- Typed-command outcome ----------

  /** Terminal states a vault write settles into (kit.js `outcomeMessage`). */
  type VaultOutcomeStatus =
    | 'executed'
    | 'parked'
    | 'queued'
    | 'in-flight'
    | 'failed'
    | 'denied';

  /**
   * The outcome of a typed-command invocation — `window.centraid.write(...)`
   * and `ctx.vault.invoke(...)` both settle to this. Only `status` is always
   * present; the rest are status-dependent (`output` on success, `reason`/
   * `predicate` on failure/denial, `invocationId`/`receiptId` for the receipt).
   */
  interface VaultOutcome {
    status: VaultOutcomeStatus;
    output?: Record<string, unknown>;
    reason?: string;
    predicate?: string;
    message?: string;
    invocationId?: string;
    receiptId?: string;
    /** Machine code on a denial/error path (e.g. `VAULT_CONSENT`). */
    code?: string;
  }

  // ---------- ctx.vault (handler side) ----------

  /** A single `where` clause for a `ctx.vault.read`. `value` is omitted for the
   *  valueless operators (`is-null` / `not-null`), hence optional. */
  interface VaultWhere {
    column: string;
    op: string;
    value?: unknown;
  }

  /** Consent-checked read of a canonical entity as a bounded window. */
  interface VaultReadRequest {
    entity: string;
    where?: VaultWhere[];
    orderBy?: { column: string; dir?: 'asc' | 'desc' };
    limit?: number;
    purpose: string;
  }

  /** `ctx.vault.read` result: the projected rows plus the read's receipt id. */
  interface VaultReadResult {
    rows: Record<string, unknown>[];
    receiptId?: string;
  }

  /** Full-text search over a text-indexed entity (each row carries `_snippet`). */
  interface VaultSearchRequest {
    entity: string;
    query: string;
    where?: VaultWhere[];
    limit?: number;
    purpose: string;
  }

  interface VaultSearchResult {
    rows: Record<string, unknown>[];
    receiptId?: string;
  }

  /** Typed-command invocation: `{command, input, purpose}` → `VaultOutcome`. */
  interface VaultInvokeRequest {
    command: string;
    input?: Record<string, unknown>;
    purpose: string;
  }

  /** The card resolver (issue #272): (type, id) refs → renderable cards. */
  interface VaultResolveRequest {
    refs: Array<{ type: string; id: string }>;
    purpose: string;
  }

  interface VaultResolveResult {
    cards: Array<Record<string, unknown>>;
    receiptId?: string;
  }

  /**
   * The handler-side `ctx.vault` surface. Every call round-trips through the
   * worker boundary to the host, which holds the app's vault credential and
   * enforces consent — always `await`. Mirrors app-engine's `ScopedVault`.
   */
  interface VaultApi {
    read(request: VaultReadRequest): Promise<VaultReadResult>;
    search(request: VaultSearchRequest): Promise<VaultSearchResult>;
    invoke(request: VaultInvokeRequest): Promise<VaultOutcome>;
    /** Query a registered app view, clamped to this app's grants. */
    query(view: string, purpose: string): Promise<unknown>;
    /** Commands discoverable by this app (name, schema, risk, confirmation). */
    describe(): Promise<unknown>;
    /** This app's own invocations awaiting owner confirmation. */
    parked(): Promise<unknown>;
    resolve(request: VaultResolveRequest): Promise<VaultResolveResult>;
    /** Plaintext of one entity's sealed columns — receipted per item (#293). */
    reveal(request: Record<string, unknown>): Promise<unknown>;
  }

  /** Per-handler `ctx` (see worker/runner.ts): fetch, abort, vault. */
  interface HandlerCtx {
    fetch(input: string, init?: RequestInit): Promise<Response>;
    abortSignal: AbortSignal;
    vault: VaultApi;
  }

  interface HandlerLog {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  }

  interface HandlerAppRef {
    readonly id: string;
    readonly dir: string;
  }

  /** What the dispatcher expects an ACTION handler to return (app-engine `ActionResult`). */
  interface ActionResult {
    status?: number;
    body?: unknown;
  }

  /**
   * Uniform handler argument bag. Actions destructure `{ body, ctx }`; queries
   * `{ query, ctx }` (URL params) or `{ ctx }`. Every field beyond `log`/`app`/
   * `ctx` is handler-kind-specific, hence optional here — pick the one your
   * handler kind receives (mirrors app-engine `CommonHandlerArgs` +
   * `Query`/`ActionHandlerArgs`).
   */
  interface HandlerArgs {
    log: HandlerLog;
    app: HandlerAppRef;
    ctx: HandlerCtx;
    /** Action handlers: the parsed request body. */
    body?: unknown;
    /** Query handlers: the typed input (preferred; dispatcher.ts read()). */
    input?: Record<string, unknown>;
    /** Query handlers: the same input under its legacy URL-query name. */
    query?: Record<string, unknown>;
    /** Path params (reserved for future shape changes). */
    params?: Record<string, string>;
  }

  // ---------- window.centraid (page side) ----------

  /**
   * A change-feed event (kit.js `onDataChange`). A non-empty `tables` list must
   * intersect an app's declared tables to fire; an empty list ("this app
   * acted") always fires. `intentId`/`intentState` mark optimistic overlay
   * updates.
   */
  interface CentraidChangeDetail {
    tables?: string[];
    source?: string;
    intentId?: string;
    intentState?: string;
    ts?: number;
  }

  /**
   * The injected vault client. `read`/`write` are generic on their result so a
   * caller can name its projection shape (`read<BoardData>({query:'board'})`)
   * without an `any`; both default to a permissive object / `VaultOutcome`.
   */
  interface CentraidClient {
    /** The app id this client is scoped to (present on the mock; may be absent). */
    appId?: string;
    read<T = Record<string, unknown>>(opts: {
      query: string;
      input?: Record<string, unknown>;
      signal?: AbortSignal;
    }): Promise<T>;
    write<T = VaultOutcome>(opts: {
      action: string;
      input?: Record<string, unknown>;
      intentId?: string;
      signal?: AbortSignal;
    }): Promise<T>;
    describe?(): Promise<unknown>;
    /** Subscribe to the change feed; returns the unsubscribe. */
    onChange(cb: (detail: CentraidChangeDetail) => void): () => void;
    /** Native haptics bridge (mobile shell only; feature-detected). */
    haptic?: { [kind: string]: (() => void) | undefined };
  }

  interface Window {
    centraid: CentraidClient;
    /** Ask-panel config seeded inline by index.html before app code loads. */
    KIT_ASK?: Record<string, unknown>;
    /** The kit's Ask controller, mounted at kit.js eval time. */
    kitAsk?: Record<string, unknown>;
  }
}

export {};
