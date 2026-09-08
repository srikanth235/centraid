/*
 * The gateway's span emitter and its trace store (#927 P1).
 *
 * SOVEREIGN BY CONSTRUCTION. A trace record is written to ONE place — the
 * owner's own `<vaultDir>/<vaultId>/diagnostics/traces.jsonl` — and read back
 * by ONE reader, `centraid-gateway trace last`, on the same machine. No route
 * serves it, no bundle collects it, no peer plane forwards it. Because the file
 * lives inside the vault directory the erase ceremony already removes
 * (`VaultRegistry.delete` → `rmSync(plane.dir)`), purge-with-vault is a
 * property of where it is stored, not of a sweeper someone must remember to
 * run. See docs/logs.md § "Traces and work counters (#927)".
 *
 * OFF BY DEFAULT. Spans cost time on the hot path, so emission is gated by
 * `TraceSamplingPolicy` and the shipped policy is `TRACE_SAMPLING_OFF`; a
 * developer opts in with `CENTRAID_TRACE=1`. The work counters underneath are
 * the always-on half and are not affected by this switch.
 *
 * This is also the ONLY per-request gateway timing seam (#922 F1 is absorbed
 * here by root ruling): `route-latency.ts` keeps aggregate per-route
 * histograms for health, which answers "how slow is this route across the
 * fleet of requests" — it cannot answer "where did THIS request spend its
 * milliseconds", which is what a waterfall is for. Adding a second per-request
 * timing instrument beside this one is the thing the ruling forbids.
 */

import { performance } from "node:perf_hooks";

import {
  addCounters,
  diffCounters,
  mintTraceId,
  shouldSample,
  TRACE_SAMPLING_OFF,
} from "@centraid/core/protocol";
import type {
  JourneyId,
  TraceAttrs,
  TraceHop,
  TraceId,
  TraceRecord,
  TraceSamplingPolicy,
  TraceSpan,
  WorkCounters,
} from "@centraid/core/protocol";
import { gatewayWorkCounters } from "@centraid/vault";

import { engineWorkCounters } from "../engine/handlers/work-counters.js";
import type { TraceSink } from "./trace-store.js";

/**
 * The process total: the vault's statement-layer integers plus the engine's.
 * Two registries because the engine must not import the vault package (see
 * `engine/handlers/work-counters.ts`); one number because an action's cost is
 * the sum of what every layer did for it.
 */
export function processWorkCounters(): WorkCounters {
  return addCounters(gatewayWorkCounters(), engineWorkCounters());
}

/**
 * Read the sampling policy a host was started with. Absent env means OFF —
 * the shipped default outside dev and perf builds.
 */
export function traceSamplingFromEnvironment(
  env: NodeJS.ProcessEnv = process.env
): TraceSamplingPolicy {
  if (env.CENTRAID_TRACE !== "1") return TRACE_SAMPLING_OFF;
  const every = Number(env.CENTRAID_TRACE_SAMPLE_EVERY ?? "1");
  if (!Number.isSafeInteger(every) || every < 1) {
    return { enabled: true, sampleEvery: 1 };
  }
  return { enabled: true, sampleEvery: every };
}

let spanSeq = 0;
function nextSpanId(traceId: TraceId): string {
  spanSeq += 1;
  return `${traceId.slice(0, 8)}-${spanSeq.toString(36)}`;
}

/**
 * One in-flight trace. Spans nest by construction: `child()` returns an `end()`
 * that closes exactly the span it opened, so an emitter cannot mis-parent a hop
 * by forgetting a stack discipline.
 */
export interface GatewayTrace {
  readonly traceId: TraceId;
  child: (
    hop: TraceHop,
    name: string,
    parentSpanId?: string
  ) => { spanId: string; end: (attrs?: TraceAttrs) => void };
  finish: (attrs?: TraceAttrs) => TraceRecord | undefined;
}

export function beginGatewayTrace(
  traceId: TraceId,
  rootName: string,
  rootAttrs?: TraceAttrs,
  journey?: JourneyId
): GatewayTrace {
  const startMs = performance.now();
  const countersBefore = processWorkCounters();
  const spans: TraceSpan[] = [];
  return {
    traceId,
    child: (hop, name, parentSpanId) => {
      const spanId = nextSpanId(traceId);
      const childStartMs = performance.now();
      return {
        spanId,
        end: (attrs) => {
          spans.push({
            traceId,
            spanId,
            ...(parentSpanId === undefined ? {} : { parentSpanId }),
            hop,
            name,
            seat: "gateway",
            startMs: childStartMs,
            endMs: performance.now(),
            ...(attrs === undefined ? {} : { attrs }),
          });
        },
      };
    },
    /*
     * Close the trace. The counter delta is taken HERE, behind the sampling
     * guard and inside a try: `diffCounters` throws on a backwards counter and
     * a diagnostics record must never be the thing that fails a request. The
     * totals objects are allocated once per process and never replaced (see
     * `work-counters.ts`), so the throw is unreachable in practice and the
     * catch exists to keep it that way.
     */
    finish: (attrs) => {
      const rootSpanId = nextSpanId(traceId);
      const mergedAttrs =
        rootAttrs === undefined && attrs === undefined
          ? undefined
          : { ...rootAttrs, ...attrs };
      const root: TraceSpan = {
        traceId,
        spanId: rootSpanId,
        hop: "gateway",
        name: rootName,
        seat: "gateway",
        startMs,
        endMs: performance.now(),
        ...(mergedAttrs === undefined ? {} : { attrs: mergedAttrs }),
      };
      // Parentless children hang off the root: a hop that did not name a parent
      // is a direct child of the request, never an orphan the validator rejects.
      const all = [
        root,
        ...spans.map((span) =>
          span.parentSpanId === undefined
            ? { ...span, parentSpanId: rootSpanId }
            : span
        ),
      ];
      try {
        return {
          root,
          spans: all,
          counters: diffCounters(countersBefore, processWorkCounters()),
          ...(journey === undefined ? {} : { journey }),
        };
      } catch {
        return undefined;
      }
    },
  };
}

export interface GatewayTracerOptions {
  policy?: TraceSamplingPolicy;
  sink?: TraceSink;
}

/**
 * The per-process tracer. `begin()` returns undefined when this action is not
 * sampled, which is the whole hot-path cost when tracing is off: one integer
 * increment and one modulo.
 */
export class GatewayTracer {
  private actions = 0;
  private readonly policy: TraceSamplingPolicy;
  private readonly sink: TraceSink | undefined;

  constructor(options: GatewayTracerOptions = {}) {
    this.policy = options.policy ?? TRACE_SAMPLING_OFF;
    this.sink = options.sink;
  }

  get enabled(): boolean {
    return this.policy.enabled;
  }

  begin(
    name: string,
    options: {
      traceId?: TraceId;
      attrs?: TraceAttrs;
      journey?: JourneyId;
    } = {}
  ): GatewayTrace | undefined {
    if (!this.policy.enabled) return undefined;
    const sampled = shouldSample(this.policy, this.actions);
    this.actions += 1;
    if (!sampled) return undefined;
    return beginGatewayTrace(
      options.traceId ?? mintTraceId(),
      name,
      options.attrs,
      options.journey
    );
  }

  end(trace: GatewayTrace | undefined, attrs?: TraceAttrs): void {
    if (!trace) return;
    const record = trace.finish(attrs);
    if (record) this.sink?.append(record);
  }
}

/**
 * The header a seat stamps so its span tree and the gateway's share one id: the
 * intent id for a write (`traceIdOfIntent`), a minted id for a read.
 *
 * It is READ ONLY WHILE TRACING IS ENABLED, which is off in every shipped
 * build, so an untrusted caller has no ingestion surface at all by default; and
 * even enabled, the value is accepted only as an opaque token of the shape an
 * id has. Nothing is echoed back and nothing is forwarded — the id joins two
 * span trees on ONE machine, it is not a distributed-tracing context.
 */
export const TRACE_ID_HEADER = "x-centraid-trace-id";
const TRACE_ID_TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u;

export function traceIdFromHeader(value: unknown): TraceId | undefined {
  if (typeof value !== "string" || !TRACE_ID_TOKEN.test(value))
    return undefined;
  return value;
}

interface TraceableRequest {
  url?: string | undefined;
  method?: string | undefined;
  headers: Record<string, unknown>;
}

/**
 * Wrap a route handler so every request it answers is one trace. The whole
 * cost when tracing is off is `begin()` returning undefined: no span objects,
 * no counter snapshot, no store.
 */
export function traceRequests<
  Req extends TraceableRequest,
  Res extends { once: (event: "close", listener: () => void) => unknown },
>(
  handler: (req: Req, res: Res) => Promise<boolean>,
  tracer: GatewayTracer
): (req: Req, res: Res) => Promise<boolean> {
  return async (req, res) => {
    const seatTraceId = tracer.enabled
      ? traceIdFromHeader(req.headers[TRACE_ID_HEADER])
      : undefined;
    const trace = tracer.begin(`${req.method ?? "GET"} ${pathOf(req.url)}`, {
      ...(seatTraceId === undefined ? {} : { traceId: seatTraceId }),
      attrs: { route: pathOf(req.url), method: req.method ?? "GET" },
    });
    if (!trace) return handler(req, res);
    // Closed on 'close', not on return: a streamed body is measured to the
    // byte, the same reason `route-latency` records there (#659). Registered
    // BEFORE the handler runs — a handler that answers and closes within one
    // tick would otherwise leave the trace unrecorded — and idempotent, so the
    // two ways out cannot double-write one record.
    let outcome: TraceAttrs = {};
    let ended = false;
    const finish = (): void => {
      if (ended) return;
      ended = true;
      tracer.end(trace, outcome);
    };
    res.once("close", finish);
    const handled = trace.child("handler", "route");
    try {
      const answered = await handler(req, res);
      handled.end({ answered });
      outcome = { answered };
      // A handler that declined never closes this response; nothing else will
      // finish the trace, so close it here.
      if (!answered) finish();
      return answered;
    } catch (error) {
      handled.end({ failed: true });
      outcome = { failed: true };
      finish();
      throw error;
    }
  };
}

function pathOf(url = "/"): string {
  const query = url.indexOf("?");
  return query < 0 ? url : url.slice(0, query);
}
