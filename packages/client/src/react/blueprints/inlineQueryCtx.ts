import { PENDING_OVERLAY_FIELDS } from "@centraid/blueprints/apps/_shared/pending-overlay";
import type { InlineQueryModule } from "@centraid/blueprints/apps/inline-types";

import type {
  ShellReplicaReadRequest,
  ShellReplicaSearchRequest,
} from "../../replica/shell-session.js";
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
} from "../../replica/types.js";

/** The slice of the replica session an inline query context needs. */
export interface InlineReplicaSession {
  read: (
    appId: string,
    request: ShellReplicaReadRequest
  ) => Promise<ReplicaReadWireResult>;
  search: (
    appId: string,
    request: ShellReplicaSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
}

export interface OnlineOnlyError extends Error {
  code: string;
}

export interface InlineOnlineGuard {
  error: OnlineOnlyError | null;
  /** Records (once) that the query needs the online vault and returns the error. */
  mark: (reason: string) => OnlineOnlyError;
}

export function createOnlineGuard(): InlineOnlineGuard {
  const guard: InlineOnlineGuard = {
    error: null,
    mark(reason: string): OnlineOnlyError {
      if (!guard.error) {
        const error = new Error(
          `Query requires the online vault: ${reason}`
        ) as OnlineOnlyError;
        error.code = "ONLINE_ONLY";
        error.name = "OnlineOnlyError";
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
const PENDING_ROW_PROVENANCE = Symbol("centraid.pending-row-provenance");

function guardedRow(
  envelope: ReplicaRowEnvelope,
  guard: InlineOnlineGuard,
  pending: PendingRowMarker | undefined
): Record<string, unknown> {
  const missing = new Map<string, string>();
  for (const key of envelope.oversizedFields ?? [])
    missing.set(key, `oversized field ${key}`);
  const undisclosed = envelope.hasUnavailableFields === true;
  // An enumerable symbol follows ordinary object spreads performed by query
  // modules, but cannot leak onto the JSON-shaped result. It gives decorated
  // rows exact provenance even when they also contain pending foreign keys.
  const values: Record<string, unknown> & {
    [PENDING_ROW_PROVENANCE]?: PendingRowMarker;
  } = { ...(envelope.values as Record<string, unknown>) };
  if (pending) values[PENDING_ROW_PROVENANCE] = pending;
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

function receiptIdFor(result: {
  cursor?: { epoch: string; seq: number };
}): string {
  const cursor = result.cursor;
  return cursor ? `replica:${cursor.epoch}:${cursor.seq}` : "replica:local";
}

export interface InlineCtxOptions {
  session: InlineReplicaSession;
  appId: string;
  /** Whether the gateway is currently reachable (default `navigator.onLine`). */
  isOnline?: () => boolean;
  signal?: AbortSignal;
  /** Mounted scope stamped onto carried pending rows for scoped recovery. */
  scopeId?: string;
}

interface PendingRowMarker {
  rowId: string;
  identityFields: readonly string[];
  fields: Record<string, unknown>;
}

const pendingFieldNames = Object.values(PENDING_OVERLAY_FIELDS);

function pendingMarker(
  envelope: ReplicaRowEnvelope
): PendingRowMarker | undefined {
  if (typeof envelope.values[PENDING_OVERLAY_FIELDS.key] !== "string")
    return undefined;
  const identityFields = Object.entries(envelope.values).flatMap(
    ([field, value]) =>
      (field === "id" || field.endsWith("_id")) && value === envelope.rowId
        ? [field]
        : []
  );
  if (identityFields.length === 0) return undefined;
  return {
    rowId: envelope.rowId,
    identityFields,
    fields: Object.fromEntries(
      pendingFieldNames.flatMap((field) =>
        envelope.values[field] === undefined
          ? []
          : [[field, envelope.values[field]]]
      )
    ),
  };
}

function carriedPendingMarker(
  source: Record<string | symbol, unknown>,
  carried: Record<string, unknown>,
  markers: readonly PendingRowMarker[]
): PendingRowMarker | undefined {
  const exact = source[PENDING_ROW_PROVENANCE];
  if (exact && typeof exact === "object") return exact as PendingRowMarker;

  // Explicit query projections do not preserve the symbol. Their first
  // source-identity field is the row they are presenting; later `*_id`
  // values are relationships. Match the field as well as its value and refuse
  // ambiguity instead of ever assigning a parent's controls to its child.
  for (const [field, value] of Object.entries(carried)) {
    if (field !== "id" && !field.endsWith("_id")) continue;
    const candidates = markers.filter(
      (marker) =>
        marker.rowId === value && marker.identityFields.includes(field)
    );
    if (candidates.length === 1) return candidates[0];
    if (candidates.length > 1) return undefined;
  }
  return undefined;
}

/**
 * Query modules may decorate or join a replica row and legitimately select
 * only product fields. Pending identity/status is shell-owned metadata, so the
 * shell carries it across that projection by stable row identity. Apps still
 * declare only action→row projection; they never copy overlay fields by hand.
 */
function carryPendingRows(
  value: unknown,
  markers: readonly PendingRowMarker[],
  scopeId: string | undefined
): unknown {
  if (Array.isArray(value))
    return value.map((item) => carryPendingRows(item, markers, scopeId));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string | symbol, unknown>;
  const carried = Object.fromEntries(
    Object.entries(record as Record<string, unknown>).map(([key, item]) => [
      key,
      carryPendingRows(item, markers, scopeId),
    ])
  );
  const matched = carriedPendingMarker(record, carried, markers);
  if (!matched) return carried;
  return {
    ...carried,
    ...matched.fields,
    ...(scopeId ? { __centraidScopeId: scopeId } : {}),
  };
}

/**
 * The `ctx` an inline query handler receives. `read`/`search` project the local
 * replica; `resolve` NEVER rejects (offline or online it returns `{ cards: [] }`
 * when no cards can be produced locally — a rejection would blank the board);
 * every other vault effect is online-only and rejects with the bridge's codes.
 */
export function buildInlineCtx(
  options: InlineCtxOptions,
  guard: InlineOnlineGuard,
  pendingRows: PendingRowMarker[] = []
): unknown {
  const { session, appId, signal } = options;
  const effect = (name: string) => (): Promise<never> =>
    Promise.reject(guard.mark(`${name} is online-only`));

  const vault = {
    async read(
      request: ShellReplicaReadRequest
    ): Promise<{ rows: unknown[]; receiptId: string }> {
      const result = await session.read(appId, request);
      const rows = result.rows.map((row) => {
        const marker = pendingMarker(row);
        if (marker) pendingRows.push(marker);
        return guardedRow(row, guard, marker);
      });
      return {
        rows,
        receiptId: receiptIdFor(result),
      };
    },
    async search(
      request: ShellReplicaSearchRequest
    ): Promise<{ rows: unknown[]; receiptId: string }> {
      const result = await session.search(appId, request);
      const rows = result.rows.map((row) => {
        const marker = pendingMarker(row);
        if (marker) pendingRows.push(marker);
        return guardedRow(row, guard, marker);
      });
      return {
        rows,
        receiptId: receiptIdFor(result),
      };
    },
    // No client-side card resolver exists; inline apps render without far-end
    // mention cards rather than blanking (see runInlineQuery / issue #505 P4).
    resolve(): Promise<{ cards: ReplicaValue[] }> {
      return Promise.resolve({ cards: [] });
    },
    invoke: effect("invoke"),
    query: effect("query"),
    describe: effect("describe"),
    parked: effect("parked"),
    reveal: effect("reveal"),
    authenticate: effect("authenticate"),
    content: effect("content"),
    changes: effect("changes"),
  };

  return {
    abortSignal: signal,
    fetch: (): Promise<never> =>
      Promise.reject(guard.mark("fetch is online-only")),
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
  options: InlineCtxOptions & { input?: Record<string, unknown> }
): Promise<unknown> {
  const guard = createOnlineGuard();
  const pendingRows: PendingRowMarker[] = [];
  const ctx = buildInlineCtx(options, guard, pendingRows);
  const value = await module.default({
    params: {},
    query: options.input ?? {},
    input: options.input,
    app: { id: options.appId, dir: "" },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ctx,
  });
  if (guard.error) throw guard.error;
  return carryPendingRows(value, pendingRows, options.scopeId);
}
