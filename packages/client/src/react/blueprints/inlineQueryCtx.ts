import { PENDING_OVERLAY_FIELDS } from "@centraid/blueprints/apps/_shared/pending-overlay";
import { truncatedListNotice } from "@centraid/blueprints/apps/_shared/shared-copy";
import type { InlineQueryModule } from "@centraid/blueprints/apps/inline-types";
import {
  applyRecurrenceExceptions,
  collapseMissedOccurrences,
  describeRecurrence,
  expandRecurrence,
  shiftTemporal,
} from "@centraid/core/time";

import { assertBoundedReplicaRead } from "../../replica/read-plan.js";
import type {
  ShellReplicaReadRequest,
  ShellReplicaSearchRequest,
} from "../../replica/shell-session.js";
// Inline query ctx over the shell replica. Touching a field the shape does
// not carry marks ONLINE_ONLY so the caller can fall back with the same error.
import type {
  ReplicaReadWireResult,
  ReplicaRowEnvelope,
  ReplicaSearchWireResult,
  ReplicaValue,
} from "../../replica/types.js";
import { postStatus } from "../../status-channel.js";

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

// Throws ONLINE_ONLY on oversized or undisclosed fields — same conditions as
// the iframe path's `guardedRow`.
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
  // Enumerable symbol follows object spreads but cannot leak onto JSON.
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
  isOnline?: () => boolean;
  signal?: AbortSignal;
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

  // Projections drop the symbol. Match field+value; refuse ambiguity — never
  // assign a parent's controls to its child.
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

// Pending identity is shell-owned: carry it across product-field projections
// by row identity. Apps never copy overlay fields by hand.
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

// `resolve` NEVER rejects — `{ cards: [] }` rather than blanking the board.
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
      // THE WEB SEAT'S BOUNDARY (#922 0a). A query that declares no window and
      // does not accept the default one is refused HERE, where the caller's
      // own file is named in the stack, rather than answered with a page
      // silently capped at 1,000 rows.
      assertBoundedReplicaRead(request);
      const result = await session.read(appId, request);
      // Honesty is not optional and not the app's to forget: a window that cut
      // rows off says so on the one status line, from the read itself.
      if (result.truncated && result.appliedLimit !== undefined) {
        postStatus(truncatedListNotice(result.appliedLimit));
      }
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
      // A ranked page that filled its window hides hits exactly as a list read
      // hides rows, and says so on the same line (#922 0a).
      if (result.truncated && result.appliedLimit !== undefined) {
        postStatus(truncatedListNotice(result.appliedLimit));
      }
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
    // No client-side card resolver; empty cards, never blank (#505 P4).
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
    // Same civil-time engine as the gateway worker — in-process, identical summary.
    time: {
      applyRecurrenceExceptions,
      collapseMissedOccurrences,
      describeRecurrence,
      expandRecurrence,
      shiftTemporal,
    },
  };
}

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
