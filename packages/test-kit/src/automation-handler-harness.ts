/*
 * Recording rails for source-level automation handler tests.
 *
 * The vault fake is a small query engine rather than a canned-rows stub:
 * cursor, batch-capacity, and stamp-matching behavior would be impossible to
 * falsify if `ctx.vault.read` ignored its where/order/limit request. Provider
 * and model edges stay injected while the real handler module runs unchanged.
 */

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

export interface AutomationHandlerHarnessOptions {
  /** Rows per entity name, e.g. `{ "media.asset": [...] }`. */
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
  /** Answer for `ctx.vault.invoke`; the second argument is the 1-based call. */
  invoke?: (record: InvokeRecord, invocation: number) => InvokeOutcome;
}

export interface AutomationHandlerHarness {
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
      return Array.isArray(clause.value) && clause.value.includes(cell);
    case "is-null":
      return cell === undefined || cell === null;
    default:
      throw new TypeError(
        `automation-handler-harness: unsupported where op '${clause.op}'`
      );
  }
}

/** Apply the filter/order/limit semantics exposed by `ctx.vault.read`. */
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

export function createAutomationHandlerHarness(
  options: AutomationHandlerHarnessOptions = {}
): AutomationHandlerHarness {
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
        const outcome = options.invoke
          ? options.invoke(request, invokes.length)
          : { status: "executed", output: {} };
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
          `automation-handler-harness: unrouted ctx.fetch ${call.method ?? "GET"} ${call.url}`
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

/** Base64 for a byte-bearing preview/original reply. */
export const FIXTURE_BYTES = "Zml4dHVyZQ==";

export function bytesContent(mediaType = "image/jpeg"): ContentReply {
  return {
    status: "ok",
    kind: "bytes",
    mediaType,
    byteSize: 7,
    base64: FIXTURE_BYTES,
  };
}

export function textContent(text: string): ContentReply {
  return {
    status: "ok",
    kind: "text",
    mediaType: "text/plain",
    text,
    truncated: false,
  };
}

/** JSON-bodied 200, the standard provider-API happy reply. */
export function json(
  value: unknown,
  headers: Record<string, string> = {}
): FetchReply {
  return { status: 200, headers, text: JSON.stringify(value) };
}
