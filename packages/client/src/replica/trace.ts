/*
 * The seat's span emitter (#927 P1).
 *
 * A RING BUFFER, not a file. A phone has no gateway process to append to and
 * no business doing disk I/O on a scroll, so spans accumulate in a bounded
 * in-memory ring and are flushed to the owner's diagnostics store on
 * background and on the developer command (maintainer ruling, #927 OQ1). The
 * web and desktop seats use the same ring; their flush target is the gateway's
 * diagnostics store on the same machine.
 *
 * Sovereign like every other trace: the ring is process-local, the flush writes
 * to the owner's own storage, and nothing here touches a socket. The transport
 * may stamp `TRACE_ID_HEADER` so the seat's tree and the gateway's tree join,
 * and that id is the only thing that ever crosses.
 *
 * OFF BY DEFAULT, same as the gateway: `ClientTracer` with no policy is
 * `TRACE_SAMPLING_OFF`, and `begin()` then returns undefined before allocating
 * anything.
 */

import {
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
  TraceIdFactory,
  TraceRecord,
  TraceSamplingPolicy,
  TraceSeat,
  TraceSpan,
} from "@centraid/core/protocol";

import { ClientTraceRing } from "./trace-ring.js";
import { clientWorkCounters } from "./work-counters.js";

export { ClientTraceRing, DEFAULT_TRACE_RING_CAPACITY } from "./trace-ring.js";

export interface SeatTrace {
  readonly traceId: TraceId;
  child: (
    hop: TraceHop,
    name: string,
    parentSpanId?: string
  ) => { spanId: string; end: (attrs?: TraceAttrs) => void };
  finish: (attrs?: TraceAttrs) => TraceRecord | undefined;
}

export interface ClientTracerOptions {
  seat: TraceSeat;
  policy?: TraceSamplingPolicy;
  ring?: ClientTraceRing;
  /** Hermes has no `crypto.randomUUID`; native passes its own factory. */
  idFactory?: TraceIdFactory;
  /** Injected in tests; `performance.now` where it exists, else `Date.now`. */
  now?: () => number;
}

function defaultNow(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

export class ClientTracer {
  readonly ring: ClientTraceRing;
  readonly #seat: TraceSeat;
  readonly #policy: TraceSamplingPolicy;
  readonly #idFactory: TraceIdFactory | undefined;
  readonly #now: () => number;
  #actions = 0;
  #spanSeq = 0;

  constructor(options: ClientTracerOptions) {
    this.#seat = options.seat;
    this.#policy = options.policy ?? TRACE_SAMPLING_OFF;
    this.ring = options.ring ?? new ClientTraceRing();
    this.#idFactory = options.idFactory;
    this.#now = options.now ?? defaultNow;
  }

  get enabled(): boolean {
    return this.#policy.enabled;
  }

  #nextSpanId(traceId: TraceId): string {
    this.#spanSeq += 1;
    return `${traceId.slice(0, 8)}-${this.#spanSeq.toString(36)}`;
  }

  /**
   * Open a trace for one user action. `traceId` is the INTENT ID for a write
   * (`traceIdOfIntent`) so the outbox row and the waterfall join with no lookup
   * table; a read has no intent and one is minted here.
   */
  begin(
    name: string,
    options: {
      traceId?: TraceId;
      hop?: TraceHop;
      attrs?: TraceAttrs;
      journey?: JourneyId;
    } = {}
  ): SeatTrace | undefined {
    if (!this.#policy.enabled) return undefined;
    const sampled = shouldSample(this.#policy, this.#actions);
    this.#actions += 1;
    if (!sampled) return undefined;
    const traceId =
      options.traceId ??
      (this.#idFactory ? mintTraceId(this.#idFactory) : mintTraceId());
    const seat = this.#seat;
    const now = this.#now;
    const startMs = now();
    const countersBefore = clientWorkCounters();
    const spans: TraceSpan[] = [];
    const rootHop = options.hop ?? "seat";
    const nextSpanId = (): string => this.#nextSpanId(traceId);
    return {
      traceId,
      child: (hop, childName, parentSpanId) => {
        const spanId = nextSpanId();
        const childStartMs = now();
        return {
          spanId,
          end: (attrs) => {
            spans.push({
              traceId,
              spanId,
              ...(parentSpanId === undefined ? {} : { parentSpanId }),
              hop,
              name: childName,
              seat,
              startMs: childStartMs,
              endMs: now(),
              ...(attrs === undefined ? {} : { attrs }),
            });
          },
        };
      },
      finish: (attrs) => {
        const rootSpanId = nextSpanId();
        const mergedAttrs =
          options.attrs === undefined && attrs === undefined
            ? undefined
            : { ...options.attrs, ...attrs };
        const root: TraceSpan = {
          traceId,
          spanId: rootSpanId,
          hop: rootHop,
          name,
          seat,
          startMs,
          endMs: now(),
          ...(mergedAttrs === undefined ? {} : { attrs: mergedAttrs }),
        };
        const all = [
          root,
          ...spans.map((span) =>
            span.parentSpanId === undefined
              ? { ...span, parentSpanId: rootSpanId }
              : span
          ),
        ];
        try {
          // Behind the sampling guard and over a totals object that is never
          // replaced, so `diffCounters`' backwards-counter throw is
          // unreachable; the catch keeps a diagnostics record from ever being
          // the thing that breaks a tap.
          return {
            root,
            spans: all,
            counters: diffCounters(countersBefore, clientWorkCounters()),
            ...(options.journey === undefined
              ? {}
              : { journey: options.journey }),
          };
        } catch {
          return undefined;
        }
      },
    };
  }

  /** Close a trace and park it in the ring. Undefined trace = not sampled. */
  end(trace: SeatTrace | undefined, attrs?: TraceAttrs): void {
    if (!trace) return;
    const record = trace.finish(attrs);
    if (record) this.ring.push(record);
  }
}
