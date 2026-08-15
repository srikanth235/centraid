/*
 * A recording stand-in for the automation runtime's handler rails, used by
 * the source-level suites over the HAND-AUTHORED connector/enricher handlers
 * in this tree (issue #781).
 *
 * Copy-adapted from `packages/model-runtime/automation-handlers/
 * handler-harness.ts` — automation may depend on blueprints but blueprints
 * must not import from model-runtime, so the harness is duplicated rather
 * than shared and extended with the two rails the recognition handlers never
 * use: `ctx.fetch` (route-faked provider HTTP) and the connector cursor
 * manager (`provider` / `highWater`), whose semantics mirror
 * `cursorManager` in `packages/automation/src/worker/runner.ts`.
 *
 * The vault fake is a small query engine rather than a canned-rows stub
 * because the behaviours under test — cursor advance, staged-batch capacity,
 * per-row identifier walks — are exactly the ones a `where`-ignoring stub
 * cannot falsify. Only the network edge and the vault edge are faked; the
 * handler code under test is the real, unmodified published module.
 */

import path from "node:path";
import { pathToFileURL } from "node:url";

export type VaultRow = Record<string, unknown>;

export interface ContentReply {
  status: string;
  kind?: string;
  mediaType?: string;
  base64?: string;
  text?: string;
  byteSize?: number;
  truncated?: boolean;
}

interface WhereClause {
  column: string;
  op: string;
  value?: unknown;
}

export interface ReadRequest {
  entity: string;
  where?: WhereClause[];
  orderBy?: { column: string; dir: string };
  limit?: number;
  purpose?: string;
}

export interface InvokeRecord {
  command: string;
  input: Record<string, unknown>;
  purpose?: string;
}

export interface InvokeOutcome {
  status: string;
  output?: Record<string, unknown>;
  reason?: string;
}

export interface DelegateCall {
  prompt: string;
  json?: unknown;
  content?: { contentId: string; variant: string; maxBytes?: number }[];
}

export interface FetchCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface FetchReply {
  status: number;
  headers: Record<string, string>;
  text: string;
}

export interface HarnessOptions {
  /** Rows per entity name, e.g. `{ "social.message": [...] }`. */
  entities?: Record<string, VaultRow[]>;
  /** Content replies keyed `${contentId}:${variant}`. */
  content?: Record<string, ContentReply>;
  /** Seeded handler state (`ctx.state`). */
  state?: Record<string, unknown>;
  /** `ctx.input` for the fire. */
  input?: unknown;
  /** Answer for `ctx.delegate`. */
  delegate?: (call: DelegateCall) => unknown;
  /** Answer for `ctx.fetch`; a handler without one gets an explicit throw. */
  fetch?: (call: FetchCall) => FetchReply | Promise<FetchReply>;
  /** Answer for `ctx.vault.invoke`; default stages as `item-<n>`. */
  invoke?: (record: InvokeRecord) => InvokeOutcome;
}

export interface Harness {
  ctx: Record<string, unknown>;
  log: { info: (message: string) => void; warn: (message: string) => void };
  logs: string[];
  reads: ReadRequest[];
  invokes: InvokeRecord[];
  contentRequests: { contentId: string; variant: string; maxBytes?: number }[];
  delegateCalls: DelegateCall[];
  fetches: FetchCall[];
  state: Map<string, unknown>;
}

function orderValue(value: unknown): string | number {
  if (typeof value === "number") return value;
  return value === undefined || value === null ? "" : String(value);
}

function compare(a: unknown, b: unknown): number {
  const left = orderValue(a);
  const right = orderValue(b);
  if (typeof left === "number" && typeof right === "number")
    return left - right;
  return String(left) < String(right)
    ? -1
    : String(left) > String(right)
      ? 1
      : 0;
}

function matches(row: VaultRow, clause: WhereClause): boolean {
  const cell = row[clause.column];
  switch (clause.op) {
    case "eq":
      return cell === clause.value;
    case "gt":
      return compare(cell, clause.value) > 0;
    case "in":
      return (
        Array.isArray(clause.value) &&
        clause.value.some((candidate) => candidate === cell)
      );
    case "is-null":
      return cell === undefined || cell === null;
    default:
      throw new Error(`handler-harness: unsupported where op '${clause.op}'`);
  }
}

/**
 * Runs a handler `ctx.vault.read` request against the seeded rows: the same
 * filter/order/limit semantics the real vault applies, so a handler that
 * forgets a filter clause or a batch limit reads more rows than it should
 * and the assertion on the resulting writes fails.
 */
export function selectRows(rows: VaultRow[], request: ReadRequest): VaultRow[] {
  const filtered = rows.filter((row) =>
    (request.where ?? []).every((clause) => matches(row, clause))
  );
  const ordered = request.orderBy
    ? [...filtered].sort((a, b) => {
        const column = request.orderBy?.column ?? "";
        const direction = request.orderBy?.dir === "desc" ? -1 : 1;
        return compare(a[column], b[column]) * direction;
      })
    : filtered;
  return request.limit === undefined
    ? ordered
    : ordered.slice(0, request.limit);
}

export function createHarness(options: HarnessOptions = {}): Harness {
  const entities = options.entities ?? {};
  const contentReplies = options.content ?? {};
  const state = new Map<string, unknown>(Object.entries(options.state ?? {}));
  const reads: ReadRequest[] = [];
  const invokes: InvokeRecord[] = [];
  const logs: string[] = [];
  const contentRequests: {
    contentId: string;
    variant: string;
    maxBytes?: number;
  }[] = [];
  const delegateCalls: DelegateCall[] = [];
  const fetches: FetchCall[] = [];

  const ctx = {
    now: "2099-01-01T00:00:00.000Z",
    input: options.input,
    vault: {
      read: (request: ReadRequest) => {
        reads.push(request);
        return Promise.resolve({
          rows: selectRows(entities[request.entity] ?? [], request),
          receiptId: "receipt",
        });
      },
      invoke: (request: InvokeRecord) => {
        invokes.push(request);
        const outcome: InvokeOutcome = options.invoke
          ? options.invoke(request)
          : {
              status: "executed",
              output: { item_id: `item-${invokes.length}`, status: "staged" },
            };
        return Promise.resolve(outcome);
      },
      content: (request: {
        contentId: string;
        variant: string;
        maxBytes?: number;
      }) => {
        contentRequests.push(request);
        return Promise.resolve(
          contentReplies[`${request.contentId}:${request.variant}`] ?? {
            status: "missing",
          }
        );
      },
    },
    fetch: (call: FetchCall) => {
      fetches.push(call);
      if (!options.fetch) {
        throw new Error(
          `handler-harness: unrouted ctx.fetch ${call.method ?? "GET"} ${call.url}`
        );
      }
      return Promise.resolve(options.fetch(call));
    },
    delegate: (call: DelegateCall) => {
      delegateCalls.push(call);
      return Promise.resolve(options.delegate ? options.delegate(call) : {});
    },
    state: {
      get: (key: string) => Promise.resolve(state.get(key)),
      set: (key: string, value: unknown) => {
        state.set(key, value);
        return Promise.resolve();
      },
      delete: (key: string) => {
        state.delete(key);
        return Promise.resolve();
      },
    },
  };

  return {
    ctx,
    log: {
      info: (message: string) => logs.push(message),
      warn: (message: string) => logs.push(message),
    },
    logs,
    reads,
    invokes,
    contentRequests,
    delegateCalls,
    fetches,
    state,
  };
}

/** JSON-bodied 200, the standard provider-API happy reply. */
export function json(
  value: unknown,
  headers: Record<string, string> = {}
): FetchReply {
  return { status: 200, headers, text: JSON.stringify(value) };
}

// ---------------------------------------------------------------------------
// Connector cursor manager — same observable semantics as `cursorManager` in
// packages/automation/src/worker/runner.ts: a provider cursor is a live
// opaque token (set/clear, readable back within the same fire); a high-water
// cursor only ever observes upward and refuses type changes. `updates` is
// what the runtime would persist after the fire, which is what the cursor-
// discipline assertions read.
// ---------------------------------------------------------------------------

export interface CursorHarness {
  cursor: {
    provider: (key: string) => {
      readonly current: unknown;
      set: (value: unknown) => void;
      clear: () => void;
    };
    highWater: (key: string) => {
      readonly current: unknown;
      observe: (candidate: unknown) => void;
    };
  };
  updates: Map<string, unknown>;
}

export function cursorHarness(
  initial: Record<string, unknown> = {}
): CursorHarness {
  const updates = new Map<string, unknown>();
  return {
    cursor: {
      provider(key: string) {
        let value = initial[key];
        return {
          get current(): unknown {
            return value;
          },
          set(next: unknown): void {
            value = next;
            updates.set(key, next);
          },
          clear(): void {
            value = null;
            updates.set(key, null);
          },
        };
      },
      highWater(key: string) {
        const initialValue = initial[key];
        let value: string | number | undefined =
          typeof initialValue === "string" || typeof initialValue === "number"
            ? initialValue
            : undefined;
        return {
          get current(): unknown {
            return value;
          },
          observe(candidate: unknown): void {
            if (candidate === null || candidate === undefined) return;
            if (
              typeof candidate !== "string" &&
              typeof candidate !== "number"
            ) {
              throw new Error(`high-water cursor "${key}" got a non-scalar`);
            }
            if (value !== undefined && typeof candidate !== typeof value) {
              throw new Error(`high-water cursor "${key}" changed value type`);
            }
            if (value === undefined || candidate > value) value = candidate;
            updates.set(key, value);
          },
        };
      },
    },
    updates,
  };
}

// ---------------------------------------------------------------------------
// Loading the published handlers. `fresh: true` busts the ESM cache with a
// unique query so module-level state (e.g. the Gmail connector's observed
// profile) starts clean for that test.
// ---------------------------------------------------------------------------

const TREE_ROOT = import.meta.dirname;
let freshLoads = 0;

export interface PullSpec {
  protocol: string;
  principal: (args: { ctx: Record<string, unknown> }) => Promise<string>;
  pull: (args: {
    ctx: Record<string, unknown>;
    cursor: CursorHarness["cursor"];
    log: Harness["log"];
  }) => Promise<{ rows: Record<string, unknown>[]; summary?: string }>;
}

export type EnricherHandler = (args: {
  ctx: Record<string, unknown>;
  log: Harness["log"];
}) => Promise<unknown>;

async function loadModule(
  id: string,
  fresh: boolean
): Promise<Record<string, unknown>> {
  const handler = path.join(TREE_ROOT, id, "automations", id, "handler.js");
  const url = fresh
    ? `${pathToFileURL(handler).href}?fresh=${(freshLoads += 1)}`
    : `${pathToFileURL(handler).href}?suite=${id}`;
  return (await import(url)) as Record<string, unknown>;
}

export async function loadPull(
  id: string,
  options: { fresh?: boolean } = {}
): Promise<PullSpec> {
  const mod = await loadModule(id, options.fresh === true);
  return mod.default as PullSpec;
}

export async function loadEnricher(
  id: string,
  options: { fresh?: boolean } = {}
): Promise<EnricherHandler> {
  const mod = await loadModule(id, options.fresh === true);
  return mod.default as EnricherHandler;
}
