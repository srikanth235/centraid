import { describe, expect, it } from "vitest";

import { fc } from "@centraid/test-kit/fast-check";

import {
  TRACE_FORMAT_VERSION,
  TRACE_HOPS,
  TRACE_JOURNEYS,
  TRACE_SAMPLING_OFF,
  TRACE_SEATS,
  WORK_COUNTER_KEYS,
  addCounters,
  diffCounters,
  mintTraceId,
  shouldSample,
  traceIdOfIntent,
  validateTraceRecord,
  waterfall,
  webCryptoTraceIdFactory,
  zeroCounters,
} from "./trace.js";
import type { TraceRecord, TraceSpan, WorkCounters } from "./trace.js";

const TRACE_ID = "intent-7f2c";

function span(over: Partial<TraceSpan> & { spanId: string }): TraceSpan {
  return {
    traceId: TRACE_ID,
    hop: "seat",
    name: over.spanId,
    seat: "web",
    startMs: 0,
    endMs: 1,
    ...over,
  };
}

/** seat → gateway → sqlite, with a sibling render hop under the seat. */
function threeHopRecord(): TraceRecord {
  const root = span({
    spanId: "s0",
    hop: "seat",
    name: "tap",
    startMs: 100,
    endMs: 180,
  });
  return {
    root,
    spans: [
      root,
      span({
        spanId: "s1",
        parentSpanId: "s0",
        hop: "gateway",
        name: "query",
        startMs: 110,
        endMs: 160,
      }),
      span({
        spanId: "s2",
        parentSpanId: "s1",
        hop: "sqlite",
        name: "select",
        startMs: 120,
        endMs: 150,
        attrs: { statement: "SELECT 1", rows: 4, cached: false },
      }),
      span({
        spanId: "s3",
        parentSpanId: "s0",
        hop: "render",
        name: "paint",
        startMs: 165,
        endMs: 178,
      }),
    ],
    counters: { ...zeroCounters(), statements: 1, rowsScanned: 4 },
    journey: "own-echo",
  };
}

// Built from a tuple rather than fc.record: fc.record yields null-prototype
// objects, which toStrictEqual rejects against the plain objects the contract
// returns.
const counterArbitrary: fc.Arbitrary<WorkCounters> = fc
  .array(fc.nat({ max: 10_000 }), {
    minLength: WORK_COUNTER_KEYS.length,
    maxLength: WORK_COUNTER_KEYS.length,
  })
  .map((values) => {
    const counters = zeroCounters();
    WORK_COUNTER_KEYS.forEach((key, index) => {
      counters[key] = values[index] as number;
    });
    return counters;
  });

describe("the trace vocabulary", () => {
  it("is a closed set of nine hops, four seats and nine journeys", () => {
    expect(TRACE_FORMAT_VERSION).toBe(1);
    expect([...TRACE_HOPS]).toStrictEqual([
      "seat",
      "tunnel",
      "gateway",
      "handler",
      "sqlite",
      "commit",
      "sse",
      "apply",
      "render",
    ]);
    expect([...TRACE_SEATS]).toStrictEqual([
      "mobile",
      "web",
      "desktop",
      "gateway",
    ]);
    expect([...TRACE_JOURNEYS]).toStrictEqual([
      "cold-open",
      "warm-switch",
      "own-echo",
      "peer-echo",
      "converge",
      "share",
      "search",
      "scroll",
      "first-bootstrap",
    ]);
  });
});

describe(traceIdOfIntent, () => {
  it("reuses the intent id so a write has exactly one id", () => {
    expect(traceIdOfIntent("intent-7f2c")).toBe("intent-7f2c");
  });
});

describe(mintTraceId, () => {
  it("takes an injected factory for hosts without WebCrypto", () => {
    let n = 0;
    expect(mintTraceId(() => `read-${(n += 1)}`)).toBe("read-1");
    expect(mintTraceId(() => `read-${(n += 1)}`)).toBe("read-2");
  });

  it("defaults to the WebCrypto factory and mints distinct ids", () => {
    const first = mintTraceId();
    expect(first).not.toBe(mintTraceId());
    expect(first).toHaveLength(webCryptoTraceIdFactory().length);
  });
});

describe(zeroCounters, () => {
  it("has exactly the nine keys, all zero", () => {
    expect(zeroCounters()).toStrictEqual({
      statements: 0,
      rowsScanned: 0,
      fsyncs: 0,
      bytesRead: 0,
      bytesWritten: 0,
      workerSpawns: 0,
      httpRoundTrips: 0,
      invalidations: 0,
      reReads: 0,
    });
    expect(Object.keys(zeroCounters())).toStrictEqual([...WORK_COUNTER_KEYS]);
  });
});

describe(addCounters, () => {
  it("sums key by key", () => {
    expect(
      addCounters(
        { ...zeroCounters(), statements: 2, fsyncs: 1 },
        { ...zeroCounters(), statements: 3, reReads: 5 }
      )
    ).toStrictEqual({
      ...zeroCounters(),
      statements: 5,
      fsyncs: 1,
      reReads: 5,
    });
  });

  it("[property] is associative with zero as its identity", () => {
    fc.assert(
      fc.property(
        counterArbitrary,
        counterArbitrary,
        counterArbitrary,
        (a, b, c) => {
          expect(addCounters(addCounters(a, b), c)).toStrictEqual(
            addCounters(a, addCounters(b, c))
          );
          expect(addCounters(a, zeroCounters())).toStrictEqual(a);
          expect(addCounters(zeroCounters(), a)).toStrictEqual(a);
        }
      ),
      { numRuns: 64, seed: 92701 }
    );
  });
});

describe(diffCounters, () => {
  it("[property] inverts addition on a running total", () => {
    fc.assert(
      fc.property(counterArbitrary, counterArbitrary, (before, work) => {
        const after = addCounters(before, work);
        expect(diffCounters(before, after)).toStrictEqual(work);
        expect(diffCounters(before, before)).toStrictEqual(zeroCounters());
      }),
      { numRuns: 64, seed: 44913 }
    );
  });

  it("refuses a counter that went backwards", () => {
    expect(() =>
      diffCounters({ ...zeroCounters(), fsyncs: 4 }, zeroCounters())
    ).toThrow(/fsyncs went backwards \(4 -> 0\)/u);
  });
});

describe(validateTraceRecord, () => {
  it("accepts a well-formed record and returns it structurally", () => {
    const record = threeHopRecord();
    expect(validateTraceRecord(structuredClone(record))).toStrictEqual(record);
  });

  it("accepts a record with no journey and no attrs", () => {
    const root = span({ spanId: "only", startMs: 5, endMs: 5 });
    const parsed = validateTraceRecord({
      root,
      spans: [root],
      counters: zeroCounters(),
    });
    expect(parsed.journey).toBeUndefined();
    expect(parsed.spans[0]?.attrs).toBeUndefined();
  });

  it.each([
    ["a non-object record", 7, /must be an object/u],
    [
      "a non-object root",
      { root: "x", spans: [], counters: zeroCounters() },
      /trace root: span must be an object/u,
    ],
    [
      "an empty spanId",
      {
        root: span({ spanId: "" }),
        spans: [],
        counters: zeroCounters(),
      },
      /spanId must be a non-empty string/u,
    ],
    [
      "an unknown hop",
      {
        root: { ...span({ spanId: "s0" }), hop: "network" },
        spans: [],
        counters: zeroCounters(),
      },
      /unknown hop "network"/u,
    ],
    [
      "an unknown seat",
      {
        root: { ...span({ spanId: "s0" }), seat: "watch" },
        spans: [],
        counters: zeroCounters(),
      },
      /unknown seat "watch"/u,
    ],
    [
      "a non-finite timestamp",
      {
        root: { ...span({ spanId: "s0" }), endMs: "later" },
        spans: [],
        counters: zeroCounters(),
      },
      /startMs and endMs must be finite numbers/u,
    ],
    [
      "endMs before startMs",
      {
        root: span({ spanId: "s0", startMs: 9, endMs: 4 }),
        spans: [],
        counters: zeroCounters(),
      },
      /endMs 4 precedes startMs 9/u,
    ],
    [
      "a rooted parentSpanId",
      {
        root: span({ spanId: "s0", parentSpanId: "nope" }),
        spans: [],
        counters: zeroCounters(),
      },
      /root span must have no parentSpanId/u,
    ],
    [
      "an empty parentSpanId",
      {
        root: span({ spanId: "s0" }),
        spans: [
          span({ spanId: "s0" }),
          { ...span({ spanId: "s1" }), parentSpanId: "" },
        ],
        counters: zeroCounters(),
      },
      /parentSpanId must be a non-empty string/u,
    ],
    [
      "non-array spans",
      { root: span({ spanId: "s0" }), spans: {}, counters: zeroCounters() },
      /spans must be an array/u,
    ],
    [
      "a span from another trace",
      {
        root: span({ spanId: "s0" }),
        spans: [
          span({ spanId: "s0" }),
          { ...span({ spanId: "s1" }), traceId: "other" },
        ],
        counters: zeroCounters(),
      },
      /span s1 carries traceId other, not intent-7f2c/u,
    ],
    [
      "a duplicate spanId",
      {
        root: span({ spanId: "s0" }),
        spans: [span({ spanId: "s0" }), span({ spanId: "s0" })],
        counters: zeroCounters(),
      },
      /duplicate spanId s0/u,
    ],
    [
      "a root missing from spans",
      { root: span({ spanId: "s0" }), spans: [], counters: zeroCounters() },
      /spans must contain the root span/u,
    ],
    [
      "an unknown parent",
      {
        root: span({ spanId: "s0" }),
        spans: [
          span({ spanId: "s0" }),
          span({ spanId: "s1", parentSpanId: "ghost" }),
        ],
        counters: zeroCounters(),
      },
      /span s1 has unknown parent ghost/u,
    ],
    [
      "a parent cycle detached from the root",
      {
        root: span({ spanId: "s0" }),
        spans: [
          span({ spanId: "s0" }),
          span({ spanId: "a", parentSpanId: "b" }),
          span({ spanId: "b", parentSpanId: "a" }),
        ],
        counters: zeroCounters(),
      },
      /2 span\(s\) are not reachable from the root/u,
    ],
    [
      "non-object attrs",
      {
        root: { ...span({ spanId: "s0" }), attrs: [1, 2] },
        spans: [],
        counters: zeroCounters(),
      },
      /attrs must be a flat object/u,
    ],
    [
      "a nested attr",
      {
        root: { ...span({ spanId: "s0" }), attrs: { nested: { a: 1 } } },
        spans: [],
        counters: zeroCounters(),
      },
      /attr nested must be a string, number or boolean/u,
    ],
    [
      "non-object counters",
      {
        root: span({ spanId: "s0" }),
        spans: [span({ spanId: "s0" })],
        counters: null,
      },
      /counters must be an object/u,
    ],
    [
      "an unknown counter",
      {
        root: span({ spanId: "s0" }),
        spans: [span({ spanId: "s0" })],
        counters: { ...zeroCounters(), gpuFlushes: 3 },
      },
      /unknown work counter gpuFlushes/u,
    ],
    [
      "a fractional counter",
      {
        root: span({ spanId: "s0" }),
        spans: [span({ spanId: "s0" })],
        counters: { ...zeroCounters(), rowsScanned: 1.5 },
      },
      /counter rowsScanned must be a non-negative integer/u,
    ],
    [
      "a negative counter",
      {
        root: span({ spanId: "s0" }),
        spans: [span({ spanId: "s0" })],
        counters: { ...zeroCounters(), fsyncs: -1 },
      },
      /counter fsyncs must be a non-negative integer/u,
    ],
    [
      "an unknown journey",
      {
        root: span({ spanId: "s0" }),
        spans: [span({ spanId: "s0" })],
        counters: zeroCounters(),
        journey: "doomscroll",
      },
      /unknown journey "doomscroll"/u,
    ],
    [
      "a missing name",
      {
        root: { ...span({ spanId: "s0" }), name: 42 },
        spans: [],
        counters: zeroCounters(),
      },
      /name must be a non-empty string/u,
    ],
    [
      "an empty traceId",
      {
        root: { ...span({ spanId: "s0" }), traceId: "" },
        spans: [],
        counters: zeroCounters(),
      },
      /traceId must be a non-empty string/u,
    ],
  ])("rejects %s", (_case, value, message) => {
    expect(() => validateTraceRecord(value)).toThrow(message);
  });
});

describe(waterfall, () => {
  it("orders by start, nests by parent and offsets from the root", () => {
    expect(waterfall(threeHopRecord())).toStrictEqual([
      { name: "tap", hop: "seat", offsetMs: 0, durationMs: 80, depth: 0 },
      { name: "query", hop: "gateway", offsetMs: 10, durationMs: 50, depth: 1 },
      { name: "select", hop: "sqlite", offsetMs: 20, durationMs: 30, depth: 2 },
      { name: "paint", hop: "render", offsetMs: 65, durationMs: 13, depth: 1 },
    ]);
  });

  it("breaks a start-time tie by spanId so the render is stable", () => {
    const root = span({ spanId: "s0", startMs: 0, endMs: 10 });
    const record: TraceRecord = {
      root,
      spans: [
        root,
        span({
          spanId: "b",
          parentSpanId: "s0",
          name: "b",
          startMs: 2,
          endMs: 3,
        }),
        span({
          spanId: "a",
          parentSpanId: "s0",
          name: "a",
          startMs: 2,
          endMs: 3,
        }),
        span({
          spanId: "c",
          parentSpanId: "s0",
          name: "c",
          startMs: 2,
          endMs: 3,
        }),
      ],
      counters: zeroCounters(),
    };
    expect(waterfall(record).map((row) => row.name)).toStrictEqual([
      "s0",
      "a",
      "b",
      "c",
    ]);
  });

  it("renders a lone root as a single row", () => {
    const root = span({ spanId: "s0", startMs: 4, endMs: 9 });
    expect(
      waterfall({ root, spans: [root], counters: zeroCounters() })
    ).toStrictEqual([
      { name: "s0", hop: "seat", offsetMs: 0, durationMs: 5, depth: 0 },
    ]);
  });
});

describe(shouldSample, () => {
  it("emits nothing while disabled — the shipped default", () => {
    expect(TRACE_SAMPLING_OFF).toStrictEqual({
      enabled: false,
      sampleEvery: 0,
    });
    expect(Object.isFrozen(TRACE_SAMPLING_OFF)).toBe(true);
    fc.assert(
      fc.property(fc.nat({ max: 1_000 }), (n) => {
        expect(shouldSample(TRACE_SAMPLING_OFF, n)).toBe(false);
      }),
      { numRuns: 64, seed: 31775 }
    );
  });

  it("samples every action at sampleEvery 1", () => {
    fc.assert(
      fc.property(fc.nat({ max: 1_000 }), (n) => {
        expect(shouldSample({ enabled: true, sampleEvery: 1 }, n)).toBe(true);
      }),
      { numRuns: 64, seed: 60214 }
    );
  });

  it("samples one action in N, deterministically", () => {
    const policy = { enabled: true, sampleEvery: 4 };
    expect(
      [0, 1, 2, 3, 4, 5].map((n) => shouldSample(policy, n))
    ).toStrictEqual([true, false, false, false, true, false]);
  });

  it("refuses a non-positive or fractional sampleEvery", () => {
    expect(() => shouldSample({ enabled: true, sampleEvery: 0 }, 1)).toThrow(
      /sampleEvery must be a positive integer, got 0/u
    );
    expect(() => shouldSample({ enabled: true, sampleEvery: 1.5 }, 1)).toThrow(
      /sampleEvery must be a positive integer, got 1.5/u
    );
  });

  it("refuses a counter value that is not a non-negative integer", () => {
    expect(() => shouldSample({ enabled: true, sampleEvery: 2 }, -1)).toThrow(
      /counterValue must be a non-negative integer, got -1/u
    );
    expect(() => shouldSample({ enabled: true, sampleEvery: 2 }, 0.5)).toThrow(
      /counterValue must be a non-negative integer, got 0.5/u
    );
  });
});
