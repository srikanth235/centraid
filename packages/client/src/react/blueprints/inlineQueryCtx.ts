// Reproduce the served bridge's local-query execution (packages/app-engine
// bridge-script.ts `runLocalQuery` / `localVault`, lines ~158-263) for the
// INLINE path — but backed directly by the shell replica session instead of the
// `centraid:replica-read` MessagePort round-trip. A blueprint query module
// (`queries/<name>.ts`) is a pure function of `{ input, ctx }`; here `ctx.vault`
// reads/searches the local replica, shapes the wire envelopes into the
// `{ rows, receiptId }` the query expects, and marks an online-only guard the
// instant a query touches a field the shape does not carry — so the caller
// (centraid-inline) can fall back to the gateway with the SAME error contract.
import type {
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
  ReplicaValue,
} from '../../replica/types.js';
import type {
  ShellReplicaReadRequest,
  ShellReplicaSearchRequest,
} from '../../replica/shell-session.js';
import type { InlineQueryModule } from '@centraid/blueprints/apps/inline-types';

/** The slice of the replica session an inline query context needs. */
export interface InlineReplicaSession {
  read(appId: string, request: ShellReplicaReadRequest): Promise<ReplicaReadWireResult>;
  search(appId: string, request: ShellReplicaSearchRequest): Promise<ReplicaSearchWireResult>;
}

export interface OnlineOnlyError extends Error {
  code: string;
}

export interface InlineOnlineGuard {
  error: OnlineOnlyError | null;
  /** Records (once) that the query needs the online vault and returns the error. */
  mark(reason: string): OnlineOnlyError;
}

export function createOnlineGuard(): InlineOnlineGuard {
  const guard: InlineOnlineGuard = {
    error: null,
    mark(reason: string): OnlineOnlyError {
      if (!guard.error) {
        const error = new Error(`Query requires the online vault: ${reason}`) as OnlineOnlyError;
        error.code = 'ONLINE_ONLY';
        error.name = 'OnlineOnlyError';
        guard.error = error;
      }
      return guard.error;
    },
  };
  return guard;
}

// A row proxy that throws the online-only guard the moment a query reads an
// oversized (masked) or undisclosed field — verbatim behaviour port of the
// bridge's `guardedRow`, so an inline read escalates to the gateway on exactly
// the same conditions the iframe path did.
function guardedRow(
  envelope: ReplicaRowEnvelope,
  guard: InlineOnlineGuard,
): Record<string, unknown> {
  const missing = new Map<string, string>();
  for (const key of envelope.oversizedFields ?? []) missing.set(key, `oversized field ${key}`);
  const undisclosed = envelope.hasUnavailableFields === true;
  const values = { ...(envelope.values as Record<string, unknown>) };
  const unavailable = (target: Record<string, unknown>, key: string | symbol): boolean =>
    typeof key === 'string' && (missing.has(key) || (undisclosed && !(key in target)));
  const fail = (key?: string | symbol): never => {
    throw guard.mark(
      (typeof key === 'string' && missing.get(key)) || 'accessing undisclosed unavailable fields',
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

function receiptIdFor(result: { cursor?: { epoch: string; seq: number } }): string {
  const cursor = result.cursor;
  return cursor ? `replica:${cursor.epoch}:${cursor.seq}` : 'replica:local';
}

export interface InlineCtxOptions {
  session: InlineReplicaSession;
  appId: string;
  /** Whether the gateway is currently reachable (default `navigator.onLine`). */
  isOnline?: () => boolean;
  signal?: AbortSignal;
}

/**
 * The `ctx` an inline query handler receives. `read`/`search` project the local
 * replica; `resolve` NEVER rejects (offline or online it returns `{ cards: [] }`
 * when no cards can be produced locally — a rejection would blank the board);
 * every other vault effect is online-only and rejects with the bridge's codes.
 */
export function buildInlineCtx(options: InlineCtxOptions, guard: InlineOnlineGuard): unknown {
  const { session, appId, signal } = options;
  const effect = (name: string) => (): Promise<never> =>
    Promise.reject(guard.mark(`${name} is online-only`));

  const vault = {
    async read(request: ShellReplicaReadRequest): Promise<{ rows: unknown[]; receiptId: string }> {
      const result = await session.read(appId, request);
      return {
        rows: result.rows.map((row) => guardedRow(row, guard)),
        receiptId: receiptIdFor(result),
      };
    },
    async search(
      request: ShellReplicaSearchRequest,
    ): Promise<{ rows: unknown[]; receiptId: string }> {
      const result = await session.search(appId, request);
      return {
        rows: result.rows.map((row) => guardedRow(row, guard)),
        receiptId: receiptIdFor(result),
      };
    },
    // No client-side card resolver exists; inline apps render without far-end
    // mention cards rather than blanking (see runInlineQuery / issue #505 P4).
    resolve(): Promise<{ cards: ReplicaValue[] }> {
      return Promise.resolve({ cards: [] });
    },
    invoke: effect('invoke'),
    query: effect('query'),
    describe: effect('describe'),
    parked: effect('parked'),
    reveal: effect('reveal'),
    content: effect('content'),
    changes: effect('changes'),
  };

  return {
    abortSignal: signal,
    fetch: (): Promise<never> => Promise.reject(guard.mark('fetch is online-only')),
    vault,
  };
}

/**
 * Run one blueprint query module against the local replica. Resolves with the
 * query's value, or rejects with the online-only guard error (code
 * `ONLINE_ONLY`) if the query touched a field the shape does not carry — the
 * caller escalates to the gateway on that signal.
 */
export async function runInlineQuery(
  module: InlineQueryModule,
  options: InlineCtxOptions & { input?: Record<string, unknown> },
): Promise<unknown> {
  const guard = createOnlineGuard();
  const ctx = buildInlineCtx(options, guard);
  const value = await module.default({
    params: {},
    query: options.input ?? {},
    input: options.input,
    app: { id: options.appId, dir: '' },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ctx,
  });
  if (guard.error) throw guard.error;
  return value;
}
