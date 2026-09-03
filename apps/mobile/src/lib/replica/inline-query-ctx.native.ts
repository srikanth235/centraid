/**
 * SPIKE (#922 wave 1, ruling (i)): the native half of the Metro-loadable
 * `queries/*.ts` entry.
 *
 * The web seat runs a blueprint query handler on-device by handing it a `ctx`
 * built over the shell replica session
 * (`packages/client/src/react/blueprints/inlineQueryCtx.ts` → `runInlineQuery`).
 * The phone holds the same rows in its mounted replica, so the same handler can
 * run here — this module is the `ctx` the phone supplies.
 *
 * WHY IT IS A SEPARATE FILE AND NOT THE WEB ONE: `inlineQueryCtx.ts` is
 * runtime-DOM-free already (its only runtime imports are `@centraid/core/time`
 * and blueprints' `pending-overlay`), but `@centraid/client` publishes no
 * subpath that reaches it, so no seat outside `packages/client` can import it.
 * Adopting the loader means lifting that ONE builder to a shared subpath and
 * deleting this file — never keeping two. See the receipt's Recommendation.
 *
 * Nothing in the product imports this yet: this is the evidence for the
 * adopt/refuse ruling, not the wiring (that is E7's).
 */
import type {
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
} from "@centraid/client/replica/native";
import {
  applyRecurrenceExceptions,
  collapseMissedOccurrences,
  describeRecurrence,
  expandRecurrence,
  shiftTemporal,
} from "@centraid/core/time";

import type { NativeReadRequest, NativeSearchRequest } from "./native-session";

/** What a handler needs from the phone: the mounted read plane, nothing else. */
export interface NativeInlineQuerySession {
  read: (
    appId: string,
    request: NativeReadRequest
  ) => Promise<ReplicaReadWireResult>;
  search: (
    appId: string,
    request: NativeSearchRequest
  ) => Promise<ReplicaSearchWireResult>;
}

export interface NativeOnlineOnlyError extends Error {
  code: string;
}

export interface NativeInlineGuard {
  error: NativeOnlineOnlyError | null;
  mark: (reason: string) => NativeOnlineOnlyError;
}

/**
 * A handler that touches a field the replica shape does not carry, or a verb
 * only the gateway can answer, marks the run ONLINE_ONLY — the same code the
 * web path raises, so the caller's fallback is the same on both seats.
 */
export function createNativeOnlineGuard(): NativeInlineGuard {
  const guard: NativeInlineGuard = {
    error: null,
    mark(reason: string): NativeOnlineOnlyError {
      if (!guard.error) {
        const error = new Error(
          `Query requires the online vault: ${reason}`
        ) as NativeOnlineOnlyError;
        error.code = "ONLINE_ONLY";
        error.name = "OnlineOnlyError";
        guard.error = error;
      }
      return guard.error;
    },
  };
  return guard;
}

/**
 * Rows the replica stripped (0b's oversized list) or never disclosed must not
 * read as absent data: touching one throws rather than letting a handler fold a
 * missing value into a total. Same conditions as the web path's `guardedRow`.
 */
function guardedRow(
  envelope: ReplicaRowEnvelope,
  guard: NativeInlineGuard
): Record<string, unknown> {
  const missing = new Map<string, string>();
  for (const key of envelope.oversizedFields ?? [])
    missing.set(key, `oversized field ${key}`);
  const undisclosed = envelope.hasUnavailableFields === true;
  const values: Record<string, unknown> = {
    ...(envelope.values as Record<string, unknown>),
  };
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

function receiptIdFor(result: {
  cursor?: { epoch: string; seq: number };
}): string {
  const cursor = result.cursor;
  return cursor ? `replica:${cursor.epoch}:${cursor.seq}` : "replica:local";
}

export interface NativeInlineCtxOptions {
  session: NativeInlineQuerySession;
  appId: string;
  signal?: AbortSignal;
}

/**
 * The read-only ctx. Every write verb and every gateway-only verb rejects: the
 * `handler-contract` directive's read-only rule is kept by construction here,
 * not by trusting the handler.
 */
export function buildNativeInlineCtx(
  options: NativeInlineCtxOptions,
  guard: NativeInlineGuard
): unknown {
  const { session, appId, signal } = options;
  const effect = (name: string) => (): Promise<never> =>
    Promise.reject(guard.mark(`${name} is online-only`));

  const vault = {
    async read(
      request: NativeReadRequest
    ): Promise<{ rows: unknown[]; receiptId: string }> {
      const result = await session.read(appId, request);
      return {
        rows: result.rows.map((row) => guardedRow(row, guard)),
        receiptId: receiptIdFor(result),
      };
    },
    async search(
      request: NativeSearchRequest
    ): Promise<{ rows: unknown[]; receiptId: string }> {
      const result = await session.search(appId, request);
      return {
        rows: result.rows.map((row) => guardedRow(row, guard)),
        receiptId: receiptIdFor(result),
      };
    },
    // No local card resolver: empty cards, never a blank screen (#505 P4).
    resolve(): Promise<{ cards: unknown[] }> {
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
    // The same civil-time engine the gateway worker and the web seat use, so a
    // recurrence summary reads identically wherever the handler runs.
    time: {
      applyRecurrenceExceptions,
      collapseMissedOccurrences,
      describeRecurrence,
      expandRecurrence,
      shiftTemporal,
    },
  };
}

/** The handler default export, typed as the inline contract types it. */
export type NativeInlineQueryModule = {
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
};

/** Run one blueprint query handler against the phone's mounted replica. */
export async function runNativeInlineQuery(
  module: NativeInlineQueryModule,
  options: NativeInlineCtxOptions & { input?: Record<string, unknown> }
): Promise<unknown> {
  const guard = createNativeOnlineGuard();
  const ctx = buildNativeInlineCtx(options, guard);
  const value = await module.default({
    params: {},
    query: options.input ?? {},
    input: options.input,
    app: { id: options.appId, dir: "" },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    ctx,
  });
  if (guard.error) throw guard.error;
  return value;
}
