import type { PendingOverlaySidecar } from "@centraid/blueprints/apps/_shared/pending-overlay";
/**
 * The ONE inline-query `ctx`, for every seat that holds a replica (#922).
 *
 * A blueprint `queries/<name>.ts` handler is written against the gateway's
 * `HandlerCtx`. Both replica seats run it locally instead: the shell over its
 * browser replica session, the phone over its mounted native session. What
 * differs between them is ONE closure — how a read reaches rows — and nothing
 * else: the unavailable-field row proxy, the receipt id, the verb surface and
 * the civil-time engine are identical, so they live here and are imported,
 * never restated. The stickiness of an online-only refusal is not restated
 * either: `OnlineOnlyGuard` beside this file already owns it.
 *
 * This module is deliberately DOM-free and lives under `replica/` rather than
 * `react/blueprints/`: it is re-exported through `@centraid/client/replica/native`,
 * which React Native consumes from source, and a single `window` type in its
 * import graph would drag `gateway-client-core.ts` and the rest of the browser
 * engine into a Metro bundle and an Expo typecheck.
 *
 * It is also read-only by construction. Every write verb and every verb only a
 * gateway can answer rejects with `ONLINE_ONLY`; the `handler-contract`
 * directive's rule that a query never writes is kept by the ctx, not by
 * trusting the handler.
 */
import {
  applyRecurrenceExceptions,
  collapseMissedOccurrences,
  describeRecurrence,
  expandRecurrence,
  shiftTemporal,
} from "@centraid/core/time";

import type { OnlineOnlyGuard } from "./online-only-guard.js";
import type { ReplicaRowEnvelope } from "./types.js";

/**
 * Wrap one row so a value the replica stripped (an oversized column) or never
 * disclosed cannot read as absent data — a handler must not fold a missing
 * number into a total. Touching one marks the run ONLINE_ONLY.
 *
 * `extras` are seat-owned properties carried on the row (the shell threads its
 * pending-row provenance symbol through here). A row with nothing missing is
 * returned as a plain object: the Proxy is the exception, not the tax.
 */
export function guardedRow(
  envelope: ReplicaRowEnvelope,
  guard: OnlineOnlyGuard,
  extras: ReadonlyArray<readonly [string | symbol, unknown]> = []
): Record<string, unknown> {
  const missing = new Map<string, string>();
  for (const key of envelope.oversizedFields ?? [])
    missing.set(key, `oversized field ${key}`);
  const undisclosed = envelope.hasUnavailableFields === true;
  const values: Record<string, unknown> = {
    ...(envelope.values as Record<string, unknown>),
  };
  for (const [key, value] of extras)
    (values as Record<string | symbol, unknown>)[key] = value;
  if (missing.size === 0 && !undisclosed) return values;
  const unavailable = (
    target: Record<string, unknown>,
    key: string | symbol
  ): boolean =>
    typeof key === "string" &&
    (missing.has(key) || (undisclosed && !(key in target)));
  const fail = (key?: string | symbol): never => {
    throw guard.mark(
      (typeof key === "string" && missing.get(key)) ||
        "accessing undisclosed unavailable fields"
    );
  };
  return new Proxy(values, {
    get(target, key) {
      if (unavailable(target, key)) fail(key);
      return target[key as string];
    },
    has(target, key) {
      if (unavailable(target, key)) fail(key);
      return key in target;
    },
    ownKeys(target) {
      if (missing.size || undisclosed) fail();
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      if (unavailable(target, key)) fail(key);
      return Object.getOwnPropertyDescriptor(target, key);
    },
  });
}

/** No consent receipt is written locally; the cursor makes the origin inspectable. */
export function receiptIdFor(result: {
  cursor?: { epoch: string; seq: number };
}): string {
  const cursor = result.cursor;
  return cursor ? `replica:${cursor.epoch}:${cursor.seq}` : "replica:local";
}

/** What a handler's `ctx.vault.read` / `.search` settle to. */
export interface InlineRowsResult {
  rows: unknown[];
  receiptId: string;
  /** What is happening to the queued writes these rows carry (#922 G3). */
  pending?: PendingOverlaySidecar;
}

/**
 * The seat's whole contribution: how a read and a search reach rows.
 */
export interface InlineCtxReads<Read, Search> {
  read: (request: Read) => Promise<InlineRowsResult>;
  search: (request: Search) => Promise<InlineRowsResult>;
}

/**
 * A replica session's wire surface, as both seats already expose it. The
 * truncation fields (#922 0a) are carried here rather than read off a seat's
 * own result type, so the seat that must SAY something about a cut-off page can
 * see it without a second unwrapping of the result.
 */
export interface InlineWireResult {
  rows: ReplicaRowEnvelope[];
  pending?: PendingOverlaySidecar;
  cursor?: { epoch: string; seq: number };
  /** The window filled and rows were cut off. */
  truncated?: boolean;
  /** The window that did the cutting. */
  appliedLimit?: number;
}

/**
 * What a seat does AROUND a read, beyond turning envelopes into rows.
 *
 * Both are seat-owned on purpose. Refusing an undeclared unbounded read names
 * the caller's own file in the stack, and announcing a truncation needs the
 * seat's status surface — the shell has a status line, a React Native screen
 * does not — so neither belongs in a module both seats share. What IS shared is
 * that they are asked at the same two points, which is what this hook fixes.
 */
export interface InlineReadHooks<Read, Search> {
  /** Runs before the request reaches the session; throw to refuse it. */
  beforeRead?: (request: Read) => void;
  beforeSearch?: (request: Search) => void;
  /** Runs on every read and search result, before rows are projected. */
  onResult?: (result: InlineWireResult) => void;
}

export interface InlineWireSession<Read, Search> {
  read: (appId: string, request: Read) => Promise<InlineWireResult>;
  search: (appId: string, request: Search) => Promise<InlineWireResult>;
}

/**
 * Build the reads from a replica session. Both seats' sessions have the same
 * `(appId, request) -> wire result` shape, so the only thing a seat still says
 * for itself is what one ROW becomes — the shell threads pending-row
 * provenance onto it, the phone does not.
 */
export function inlineReadsFor<Read, Search>(
  session: InlineWireSession<Read, Search>,
  appId: string,
  row: (
    envelope: ReplicaRowEnvelope,
    sidecar: PendingOverlaySidecar
  ) => unknown,
  hooks: InlineReadHooks<Read, Search> = {}
): InlineCtxReads<Read, Search> {
  const project = (result: InlineWireResult): InlineRowsResult => {
    hooks.onResult?.(result);
    // One sidecar per read, shared by every row it answers for: the rows carry
    // the intent key, this carries what the member is told about it (#922 G3).
    const sidecar = result.pending ?? {};
    return {
      rows: result.rows.map((envelope) => row(envelope, sidecar)),
      receiptId: receiptIdFor(result),
      pending: sidecar,
    };
  };
  return {
    read: async (request) => {
      hooks.beforeRead?.(request);
      return project(await session.read(appId, request));
    },
    search: async (request) => {
      hooks.beforeSearch?.(request);
      return project(await session.search(appId, request));
    },
  };
}

/**
 * `ctx.time` is the gateway worker's own civil-time engine, in process. It is
 * imported here rather than passed in by each seat: "both seats use the same
 * engine" is then a fact of the module graph, not a convention two files have
 * to keep agreeing on. `@centraid/core/time` carries a `react-native` export
 * condition, so Metro resolves it from source like every other seat.
 */
const INLINE_CTX_TIME = {
  applyRecurrenceExceptions,
  collapseMissedOccurrences,
  describeRecurrence,
  expandRecurrence,
  shiftTemporal,
} as const;

export interface InlineCtxCoreOptions<Read, Search> {
  reads: InlineCtxReads<Read, Search>;
  signal?: AbortSignal;
}

/**
 * What an invocation the handler declared OPTIONAL settles to here. A
 * decoration the answer does not depend on must not refuse the answer — a
 * Locker search that cannot reach Watchtower still has its rows — so it
 * settles as the failed outcome every such call site already reads, and the
 * run stays local. An invocation that did NOT declare itself optional is an
 * effect this seat cannot perform and marks the run, as before.
 */
const OPTIONAL_INVOKE_UNAVAILABLE = {
  status: "failed",
  reason: "invoke is online-only",
} as const;

/**
 * Assemble the `ctx`. `resolve` answers `{ cards: [] }` rather than failing —
 * empty cards, never a blank board (#505 P4) — and every remaining verb is an
 * online-only effect.
 */
export function buildInlineCtxCore<Read, Search>(
  options: InlineCtxCoreOptions<Read, Search>,
  guard: OnlineOnlyGuard
): unknown {
  const effect = (name: string) => (): Promise<never> =>
    Promise.reject(guard.mark(`${name} is online-only`));
  return {
    abortSignal: options.signal,
    fetch: (): Promise<never> =>
      Promise.reject(guard.mark("fetch is online-only")),
    vault: {
      read: options.reads.read,
      search: options.reads.search,
      resolve: (): Promise<{ cards: unknown[] }> =>
        Promise.resolve({ cards: [] }),
      invoke: (request: { optional?: boolean }): Promise<unknown> =>
        request.optional === true
          ? Promise.resolve(OPTIONAL_INVOKE_UNAVAILABLE)
          : Promise.reject(guard.mark("invoke is online-only")),
      query: effect("query"),
      describe: effect("describe"),
      parked: effect("parked"),
      reveal: effect("reveal"),
      authenticate: effect("authenticate"),
      content: effect("content"),
      changes: effect("changes"),
    },
    time: INLINE_CTX_TIME,
  };
}

/**
 * A `queries/<name>.ts` module as the seats import it. Typed loosely for the
 * same reason `InlineQueryModule` is: the concrete `HandlerCtx` lives in
 * blueprints' ambient types, invisible to this package's tsconfig.
 */
export interface InlineQueryRunnable {
  default: (args: {
    params: Record<string, string>;
    query: Record<string, unknown>;
    input?: Record<string, unknown>;
    app: { id: string; dir: string };
    log: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
    ctx: unknown;
  }) => unknown;
}

/**
 * Invoke the handler and surface a marked online-only run as a rejection. The
 * raw value is returned; a seat that post-processes it (the shell carries
 * pending-row identity across projections) does so around this call.
 */
export async function runInlineQueryCore(
  module: InlineQueryRunnable,
  options: { ctx: unknown; appId: string; input?: Record<string, unknown> },
  guard: OnlineOnlyGuard
): Promise<unknown> {
  const value = await module.default({
    params: {},
    query: options.input ?? {},
    input: options.input,
    app: { id: options.appId, dir: "" },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ctx: options.ctx,
  });
  guard.assertLocal();
  return value;
}
