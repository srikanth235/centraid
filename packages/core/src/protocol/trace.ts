/*
 * The local-only trace and work-counter contract (#927 P1/P2).
 *
 * One format, imported by every emitter (gateway, web/desktop client, mobile)
 * and every consumer (journey rigs, the ledger, the developer waterfall
 * command), so a journey budget is a query over spans and a regression answers
 * *where* as well as *whether*.
 *
 * Sovereign by construction: a trace record never crosses a network boundary.
 * It is written to the owner's own diagnostics store under their vault and is
 * purged with the vault (docs/logs.md § "Traces and work counters (#927)").
 * That is why the parser here is strict rather than unknown-tolerant: C1's
 * "parse always succeeds" governs the wire between two hosts that may run
 * different versions, and no such skew exists for a record that one process
 * writes and the same machine reads. An unknown hop, seat or journey is a bug
 * in an emitter, and failing on it is what keeps the vocabulary closed.
 *
 * Zero runtime dependencies and no `node:` imports — `packages/core` is
 * consumed from source by React Native.
 */

/** Bumped when the record shape changes in a way a reader must notice. */
export const TRACE_FORMAT_VERSION = 1;

/**
 * A trace id. For a write it IS the replica intent id (`intentId` in
 * `packages/client/src/replica/types.ts`); minting a second id for the same
 * write would make the outbox and the waterfall unjoinable. Reads have no
 * intent, so they mint one on the way in.
 */
export type TraceId = string;

/** Hermes has no `crypto.randomUUID`; native hosts inject their own factory. */
export type TraceIdFactory = () => TraceId;

export const webCryptoTraceIdFactory: TraceIdFactory = () =>
  globalThis.crypto.randomUUID();

/**
 * The trace id for a write: the intent id itself. Named rather than inlined so
 * a second id generator on a write path is visible in review and in grep.
 */
export function traceIdOfIntent(intentId: string): TraceId {
  return intentId;
}

/** The trace id for a read, minted at the seat where the action starts. */
export function mintTraceId(
  factory: TraceIdFactory = webCryptoTraceIdFactory
): TraceId {
  return factory();
}

/** Every hop of a user action, seat to pixels. */
export const TRACE_HOPS = [
  "seat",
  "tunnel",
  "gateway",
  "handler",
  "sqlite",
  "commit",
  "sse",
  "apply",
  "render",
] as const;
export type TraceHop = (typeof TRACE_HOPS)[number];

/** Where a span was recorded. */
export const TRACE_SEATS = ["mobile", "web", "desktop", "gateway"] as const;
export type TraceSeat = (typeof TRACE_SEATS)[number];

/** The nine journeys the ledger is keyed by (#927 P5). */
export const TRACE_JOURNEYS = [
  "cold-open",
  "warm-switch",
  "own-echo",
  "peer-echo",
  "converge",
  "share",
  "search",
  "scroll",
  "first-bootstrap",
] as const;
export type JourneyId = (typeof TRACE_JOURNEYS)[number];

export type TraceAttrValue = string | number | boolean;
/** Flat by contract: a nested attr is not queryable from a budget expression. */
export type TraceAttrs = Record<string, TraceAttrValue>;

export interface TraceSpan {
  traceId: TraceId;
  spanId: string;
  /** Absent only on the root span. */
  parentSpanId?: string;
  hop: TraceHop;
  name: string;
  seat: TraceSeat;
  /** Monotonic-clock milliseconds, not wall clock. */
  startMs: number;
  endMs: number;
  attrs?: TraceAttrs;
}

/**
 * Deterministic integers, the always-on half of the instrumentation: spans are
 * sampled and off by default, counters are not. The merge rung compares these
 * and nothing else, so it has zero flake and needs no history.
 */
export const WORK_COUNTER_KEYS = [
  "statements",
  "rowsScanned",
  "fsyncs",
  "bytesRead",
  "bytesWritten",
  "workerSpawns",
  "httpRoundTrips",
  "invalidations",
  "reReads",
] as const;
export type WorkCounterKey = (typeof WORK_COUNTER_KEYS)[number];

/** Same shape per trace (on the root span) and per process (a running total). */
export type WorkCounters = Record<WorkCounterKey, number>;

export function zeroCounters(): WorkCounters {
  return {
    statements: 0,
    rowsScanned: 0,
    fsyncs: 0,
    bytesRead: 0,
    bytesWritten: 0,
    workerSpawns: 0,
    httpRoundTrips: 0,
    invalidations: 0,
    reReads: 0,
  };
}

export function addCounters(a: WorkCounters, b: WorkCounters): WorkCounters {
  const out = zeroCounters();
  for (const key of WORK_COUNTER_KEYS) out[key] = a[key] + b[key];
  return out;
}

/**
 * The work one action cost, taken from two reads of a process total. Counters
 * only ever climb within a process, so a negative difference means the reads
 * straddled a reset — a bug the merge rung must not average away.
 */
export function diffCounters(
  before: WorkCounters,
  after: WorkCounters
): WorkCounters {
  const out = zeroCounters();
  for (const key of WORK_COUNTER_KEYS) {
    const delta = after[key] - before[key];
    if (delta < 0) {
      throw new Error(
        `work counters: ${key} went backwards (${before[key]} -> ${after[key]})`
      );
    }
    out[key] = delta;
  }
  return out;
}

export interface TraceRecord {
  root: TraceSpan;
  /** Every span of the trace, the root included. */
  spans: TraceSpan[];
  counters: WorkCounters;
  journey?: JourneyId;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireLabel(
  value: unknown,
  label: string,
  field: string
): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label}: ${field} must be a non-empty string`);
  }
}

function requireMember<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
  field: string
): asserts value is T {
  if (!allowed.includes(value as T)) {
    throw new Error(
      `${label}: unknown ${field} ${JSON.stringify(value)} (expected one of ${allowed.join(", ")})`
    );
  }
}

function parseAttrs(value: unknown, label: string): TraceAttrs | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    throw new Error(`${label}: attrs must be a flat object`);
  }
  for (const [key, attr] of Object.entries(value)) {
    if (
      typeof attr !== "string" &&
      typeof attr !== "number" &&
      typeof attr !== "boolean"
    ) {
      throw new Error(
        `${label}: attr ${key} must be a string, number or boolean`
      );
    }
  }
  return value as TraceAttrs;
}

function parseSpan(value: unknown, label: string): TraceSpan {
  if (!isPlainObject(value))
    throw new Error(`${label}: span must be an object`);
  requireLabel(value.traceId, label, "traceId");
  requireLabel(value.spanId, label, "spanId");
  requireLabel(value.name, label, "name");
  requireMember(value.hop, TRACE_HOPS, label, "hop");
  requireMember(value.seat, TRACE_SEATS, label, "seat");
  if (value.parentSpanId !== undefined) {
    requireLabel(value.parentSpanId, label, "parentSpanId");
  }
  if (!Number.isFinite(value.startMs) || !Number.isFinite(value.endMs)) {
    throw new Error(`${label}: startMs and endMs must be finite numbers`);
  }
  const startMs = value.startMs as number;
  const endMs = value.endMs as number;
  if (endMs < startMs) {
    throw new Error(`${label}: endMs ${endMs} precedes startMs ${startMs}`);
  }
  const attrs = parseAttrs(value.attrs, label);
  return {
    traceId: value.traceId,
    spanId: value.spanId,
    ...(value.parentSpanId === undefined
      ? {}
      : { parentSpanId: value.parentSpanId as string }),
    hop: value.hop,
    name: value.name,
    seat: value.seat,
    startMs,
    endMs,
    ...(attrs === undefined ? {} : { attrs }),
  };
}

function parseCounters(value: unknown): WorkCounters {
  if (!isPlainObject(value)) {
    throw new Error("trace record: counters must be an object");
  }
  const extra = Object.keys(value).filter(
    (key) => !(WORK_COUNTER_KEYS as readonly string[]).includes(key)
  );
  if (extra.length > 0) {
    throw new Error(`trace record: unknown work counter ${extra.join(", ")}`);
  }
  const out = zeroCounters();
  for (const key of WORK_COUNTER_KEYS) {
    const count = value[key];
    if (!Number.isSafeInteger(count) || (count as number) < 0) {
      throw new Error(
        `trace record: counter ${key} must be a non-negative integer`
      );
    }
    out[key] = count as number;
  }
  return out;
}

/** Order-independent, so an attrs map that differs only in key order agrees. */
function attrsSignature(attrs: TraceAttrs | undefined): string {
  if (attrs === undefined) return "";
  return Object.keys(attrs)
    .sort()
    .map((key) => `${key}=${String(attrs[key])}`)
    .join("\0");
}

const ROOT_AGREEMENT_FIELDS = [
  "traceId",
  "parentSpanId",
  "hop",
  "name",
  "seat",
  "startMs",
  "endMs",
] as const;

/**
 * `root` and its entry in `spans` are the same span written twice, and every
 * consumer reads whichever copy is closer to hand — `waterfall` offsets from
 * `record.root` but renders the `spans` copy. Two copies that disagree would
 * therefore produce a different waterfall depending on which field was read,
 * so a disagreement is rejected rather than silently resolved in favour of
 * either side.
 */
function assertRootAgreesWithSpans(root: TraceSpan, entry: TraceSpan): void {
  for (const field of ROOT_AGREEMENT_FIELDS) {
    if (root[field] !== entry[field]) {
      throw new Error(
        `trace record: the root span disagrees with its entry in spans on ${field} (${String(root[field])} vs ${String(entry[field])})`
      );
    }
  }
  if (attrsSignature(root.attrs) !== attrsSignature(entry.attrs)) {
    throw new Error(
      "trace record: the root span disagrees with its entry in spans on attrs"
    );
  }
}

/**
 * Strict parse of a record read back from the diagnostics store. Throws on the
 * first violation; a malformed record is an emitter bug, never a version skew.
 */
export function validateTraceRecord(value: unknown): TraceRecord {
  if (!isPlainObject(value)) {
    throw new Error("trace record: must be an object");
  }
  const root = parseSpan(value.root, "trace root");
  if (root.parentSpanId !== undefined) {
    throw new Error("trace record: the root span must have no parentSpanId");
  }
  if (!Array.isArray(value.spans)) {
    throw new Error("trace record: spans must be an array");
  }
  const spans = value.spans.map((span, index) =>
    parseSpan(span, `trace span ${index}`)
  );
  const byId = new Map<string, TraceSpan>();
  for (const span of spans) {
    if (span.traceId !== root.traceId) {
      throw new Error(
        `trace record: span ${span.spanId} carries traceId ${span.traceId}, not ${root.traceId}`
      );
    }
    if (byId.has(span.spanId)) {
      throw new Error(`trace record: duplicate spanId ${span.spanId}`);
    }
    byId.set(span.spanId, span);
  }
  const rootInSpans = byId.get(root.spanId);
  if (rootInSpans === undefined) {
    throw new Error("trace record: spans must contain the root span");
  }
  assertRootAgreesWithSpans(root, rootInSpans);
  for (const span of spans) {
    if (span.parentSpanId !== undefined && !byId.has(span.parentSpanId)) {
      throw new Error(
        `trace record: span ${span.spanId} has unknown parent ${span.parentSpanId}`
      );
    }
  }
  const reachable = countReachable(spans, root.spanId);
  if (reachable !== spans.length) {
    throw new Error(
      `trace record: ${spans.length - reachable} span(s) are not reachable from the root`
    );
  }
  const counters = parseCounters(value.counters);
  if (value.journey !== undefined) {
    requireMember(value.journey, TRACE_JOURNEYS, "trace record", "journey");
  }
  return {
    root: rootInSpans,
    spans,
    counters,
    ...(value.journey === undefined
      ? {}
      : { journey: value.journey as JourneyId }),
  };
}

function childrenByParent(
  spans: readonly TraceSpan[]
): Map<string, TraceSpan[]> {
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (span.parentSpanId === undefined) continue;
    const siblings = children.get(span.parentSpanId);
    if (siblings === undefined) children.set(span.parentSpanId, [span]);
    else siblings.push(span);
  }
  // Ties broken by spanId so a waterfall is byte-stable across runs. Duplicate
  // spanIds are rejected before this runs, so the comparator is total.
  for (const siblings of children.values()) {
    siblings.sort(
      (a, b) => a.startMs - b.startMs || (a.spanId < b.spanId ? -1 : 1)
    );
  }
  return children;
}

/**
 * Rejects orphan islands and parent cycles alike: a span has at most one
 * parent, so every span the walk can reach it reaches exactly once, and
 * anything left over is either detached or in a cycle of its own.
 */
function countReachable(spans: readonly TraceSpan[], rootId: string): number {
  const children = childrenByParent(spans);
  let seen = 0;
  const queue = [rootId];
  while (queue.length > 0) {
    const id = queue.pop() as string;
    seen += 1;
    for (const child of children.get(id) ?? []) queue.push(child.spanId);
  }
  return seen;
}

export interface WaterfallRow {
  name: string;
  hop: TraceHop;
  /** Milliseconds after the root span started. */
  offsetMs: number;
  durationMs: number;
  /** 0 for the root. */
  depth: number;
}

/**
 * The record as the developer command and the journey rigs render it: ordered
 * by start, nested by parent, offsets relative to the root.
 */
export function waterfall(record: TraceRecord): WaterfallRow[] {
  const children = childrenByParent(record.spans);
  const rows: WaterfallRow[] = [];
  const stack: { span: TraceSpan; depth: number }[] = [
    { span: record.root, depth: 0 },
  ];
  while (stack.length > 0) {
    const { span, depth } = stack.pop() as { span: TraceSpan; depth: number };
    rows.push({
      name: span.name,
      hop: span.hop,
      offsetMs: span.startMs - record.root.startMs,
      durationMs: span.endMs - span.startMs,
      depth,
    });
    const kids = children.get(span.spanId) ?? [];
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      stack.push({ span: kids[i] as TraceSpan, depth: depth + 1 });
    }
  }
  return rows;
}

/**
 * Spans cost time on the hot path, so they are opt-in and sampled; the work
 * counters are the always-on half (#927 Risks §1).
 */
export interface TraceSamplingPolicy {
  enabled: boolean;
  /** Sample one action in N. Read only when `enabled`. */
  sampleEvery: number;
}

/** Emission off: the shipped default outside dev and perf builds. */
export const TRACE_SAMPLING_OFF: TraceSamplingPolicy = Object.freeze({
  enabled: false,
  sampleEvery: 0,
});

/**
 * Deterministic in the action counter, not random: two runs of the same rig
 * sample the same actions, so a waterfall diff is comparable.
 */
export function shouldSample(
  policy: TraceSamplingPolicy,
  counterValue: number
): boolean {
  if (!policy.enabled) return false;
  if (!Number.isSafeInteger(policy.sampleEvery) || policy.sampleEvery < 1) {
    throw new Error(
      `trace sampling: sampleEvery must be a positive integer, got ${policy.sampleEvery}`
    );
  }
  if (!Number.isSafeInteger(counterValue) || counterValue < 0) {
    throw new Error(
      `trace sampling: counterValue must be a non-negative integer, got ${counterValue}`
    );
  }
  return counterValue % policy.sampleEvery === 0;
}
