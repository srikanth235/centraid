/*
 * A recording stand-in for the automation runtime's handler `ctx`, used by the
 * source-level handler suites in this directory (issue #781).
 *
 * The five recognition handlers here are the SOURCE of the bundles published
 * under `packages/blueprints/automations/<id>/automations/<id>/handler.js`.
 * `packages/automation/src/manifest/enricher-templates.test.ts` owns the spine
 * contract of the *bundled* copies (typed vault commands, honest-failure vs
 * honest-skip, cursor advance) and `bundle-drift.test.ts` here proves the two
 * are the same program. These suites therefore own what that one does not:
 * input validation, request/response shaping, model-availability and
 * model-change wiring, and the postprocessing arithmetic.
 *
 * The fake is a small query engine rather than a canned-rows stub because the
 * behaviours under test — cursor advance, batch capacity, per-request walks,
 * stamp matching — are exactly the ones a `where`-ignoring stub cannot
 * falsify. Only the model edge (weights + inference) and the vault edge are
 * faked; the handler code under test is the real, unmodified module.
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

export interface DelegateCall {
  prompt: string;
  json?: unknown;
  content?: { contentId: string; variant: string; maxBytes?: number }[];
}

export interface HarnessOptions {
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
}

export interface Harness {
  ctx: Record<string, unknown>;
  log: { info: (message: string) => void; warn: (message: string) => void };
  logs: string[];
  reads: ReadRequest[];
  invokes: InvokeRecord[];
  contentRequests: { contentId: string; variant: string; maxBytes?: number }[];
  delegateCalls: DelegateCall[];
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
 * forgets a cursor clause or a batch limit reads more rows than it should and
 * the assertion on the returned counts fails.
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
        return Promise.resolve({ status: "executed", output: {} });
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
